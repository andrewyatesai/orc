#!/usr/bin/env node
// Run Trust verification over the first-party crates and report what was proved.
//
// WHY THIS EXISTS SEPARATELY FROM EVERY OTHER BUILD. Verification is real but
// slow — orca-core alone measured 42m12s — so every routine script in this repo
// (run-parity, build-orca-git-wasm, build-terminal-addon) deliberately pins to
// the STABLE toolchain, which has no verifier. That is a sensible trade for a
// fast inner loop, but it left verification as something nobody ever actually
// ran: the cargo configs sat broken for an unknown stretch and no gate noticed,
// because no gate builds with Trust.
//
// So this is the lane where verification is the point. It REPORTS rather than
// gates: a 42-minute build cannot sit in front of a commit, and a gate everyone
// learns to skip is worse than a report someone reads.
//
// USAGE
//   node config/scripts/run-rust-verification.mjs                  # default set
//   node config/scripts/run-rust-verification.mjs orca-core        # named crates
//   node config/scripts/run-rust-verification.mjs --all            # all 27
//   node config/scripts/run-rust-verification.mjs --json           # machine output
//
// EXIT: 0 when every requested crate compiled, whatever the verdicts — an
// unproved obligation is information, not a build failure, and lame mode is what
// makes that true. Non-zero only when a crate FAILED TO COMPILE or the toolchain
// is missing, because both mean the run measured nothing.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const RUST = join(ROOT, 'rust')

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const wantAll = argv.includes('--all')
const named = argv.filter((a) => !a.startsWith('--'))

// The cores that carry ported logic and vectors. Not the whole workspace by
// default: verifying vendored dependencies is most of the wall clock and least
// of the value, and orca-aterm-demo/orca-parity are harnesses, not shipped logic.
const DEFAULT_CRATES = [
  'orca-core',
  'orca-config',
  'orca-git',
  'orca-text',
  'orca-policy',
  'orca-agents',
]

function allCrates() {
  return readdirSync(join(RUST, 'crates')).filter((c) => c.startsWith('orca-')).sort()
}

const crates = named.length > 0 ? named : wantAll ? allCrates() : DEFAULT_CRATES

function hasTrustToolchain() {
  const probe = spawnSync('rustup', ['run', 'trust', 'rustc', '--version'], { stdio: 'ignore' })
  return probe.status === 0
}

if (!hasTrustToolchain()) {
  console.error('[verify:rust] the `trust` rustup toolchain is not installed — nothing was verified.')
  console.error('              This is a hard failure, not a skip: a run that measures nothing must')
  console.error('              not look like a run that found nothing.')
  process.exit(1)
}

/** Parse the per-function verdict lines Trust emits into one tally. */
function tally(output) {
  const t = { functions: 0, obligations: 0, proved: 0, failed: 0, unknown: 0, timedOut: 0, runtimeChecked: 0 }
  const line = /(\d+) proved, (\d+) failed, (\d+) unknown, (\d+) timed out, (\d+) runtime-checked out of (\d+) obligation/g
  for (const m of output.matchAll(line)) {
    t.functions += 1
    t.proved += Number(m[1])
    t.failed += Number(m[2])
    t.unknown += Number(m[3])
    t.timedOut += Number(m[4])
    t.runtimeChecked += Number(m[5])
    t.obligations += Number(m[6])
  }
  // `unsupported` is the absent-callee residue: a std/extern body that is not in
  // the lowered bundle. It is the Trust-Std gap, not a defect in our code, and it
  // is counted separately so it cannot be mistaken for either.
  t.unsupported = [...output.matchAll(/unsupported=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0)
  return t
}

const results = []
for (const crate of crates) {
  const started = process.hrtime.bigint()
  process.stderr.write(`[verify:rust] ${crate} … `)
  const run = spawnSync('rustup', ['run', 'trust', 'cargo', 'build', '-p', crate], {
    cwd: RUST,
    encoding: 'utf8',
    maxBuffer: 512e6,
  })
  const seconds = Number(process.hrtime.bigint() - started) / 1e9
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const compiled = run.status === 0
  const t = tally(output)
  results.push({ crate, compiled, seconds, ...t })
  process.stderr.write(
    compiled
      ? `ok ${seconds.toFixed(0)}s — ${t.obligations} obligation(s), ${t.proved} proved\n`
      : `DID NOT COMPILE (${seconds.toFixed(0)}s)\n`
  )
  if (!compiled) {
    const first = output.split('\n').find((l) => l.startsWith('error')) ?? '(no error line)'
    process.stderr.write(`               ${first}\n`)
  }
}

if (wantJson) {
  console.log(JSON.stringify({ crates: results }, null, 2))
} else {
  const pad = (s, n) => String(s).padEnd(n)
  const num = (s, n) => String(s).padStart(n)
  console.log('')
  console.log(`  ${pad('crate', 22)}${num('oblig', 7)}${num('proved', 8)}${num('failed', 8)}${num('unknown', 9)}${num('timeout', 9)}${num('unsupp', 8)}${num('secs', 7)}`)
  console.log(`  ${'-'.repeat(78)}`)
  for (const r of results) {
    if (!r.compiled) {
      console.log(`  ${pad(r.crate, 22)}${num('DID NOT COMPILE', 47)}${num(r.seconds.toFixed(0), 7)}`)
      continue
    }
    console.log(
      `  ${pad(r.crate, 22)}${num(r.obligations, 7)}${num(r.proved, 8)}${num(r.failed, 8)}${num(r.unknown, 9)}${num(r.timedOut, 9)}${num(r.unsupported, 8)}${num(r.seconds.toFixed(0), 7)}`
    )
  }
  const sum = (k) => results.filter((r) => r.compiled).reduce((n, r) => n + r[k], 0)
  console.log(`  ${'-'.repeat(78)}`)
  console.log(
    `  ${pad('total', 22)}${num(sum('obligations'), 7)}${num(sum('proved'), 8)}${num(sum('failed'), 8)}${num(sum('unknown'), 9)}${num(sum('timedOut'), 9)}${num(sum('unsupported'), 8)}${num(sum('seconds').toFixed(0), 7)}`
  )
  console.log('')
  if (sum('timedOut') > 0) {
    console.log(`  ${sum('timedOut')} obligation(s) TIMED OUT at the -Ztrust-verify-function-budget-ms`)
    console.log('  budget. A timeout is an assumption, not a proof, and which functions hit it can')
    console.log('  vary with machine load — raise the budget in .cargo/config.toml if this grows.')
    console.log('')
  }
  console.log('  Unproved is not the same as wrong: `unsupported` is the absent-callee residue')
  console.log('  (a std body outside the lowered bundle), which no source change here reaches.')
  console.log('')
}

const brokeCompile = results.filter((r) => !r.compiled)
if (brokeCompile.length > 0) {
  console.error(`[verify:rust] ${brokeCompile.length} crate(s) did not compile: ${brokeCompile.map((r) => r.crate).join(', ')}`)
  process.exit(1)
}
