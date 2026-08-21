#!/usr/bin/env node
// The TS-to-Rust migration cannot silently rot.
//
// READS HEAD, NOT THE WORKING TREE, and that is deliberate. This repo routinely
// carries well over a thousand uncommitted files from parallel sessions,
// including half-finished cutovers whose shims are untracked and whose adapter
// headers already announce a cutover that is not committed. A gate reading that
// tree would be red through no fault of whoever ran it, and a permanently red
// gate is precisely the failure this exists to prevent — `check:wasm-pins` was
// red at HEAD for days while printing the exact reason a broken artifact
// shipped. The census is a claim about the COMMITTED migration, so it is checked
// against the committed tree.
//
// Every parity-backed module must sit in one of three terminal states, recorded
// in `config/cutover-census.json`: `crossed`, `retained` (a TS impl stays, for a
// stated reason) or `never` (held out of the shipped artifacts by design). This
// gate re-checks those CLAIMS against the tree — it does not infer them, because
// inference is what produced three wrong findings in one session.
//
// What it enforces:
//  1. No un-triaged module. A new vector file with no entry fails, so "decide
//     about this" cannot be skipped by adding a module and moving on.
//  2. No orphan entry. An entry naming a vector file that no longer exists fails.
//  3. `retained`/`never` must give a reason. An empty one fails.
//  4. A refusal with a `check` script must still be TRUE: the script runs and
//     must exit 0. Those scripts are written to exit non-zero once their blocker
//     clears, so a stale refusal reddens instead of quietly outliving its reason.
//  5. A `crossed` claim must still hold: its adapter must reach the core, either
//     through the wasm/napi oracle or through a file that dispatches. A reverted
//     cutover fails here.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const ORACLE = /gitWasmOracle|requireRustGitBinding|rust-git-addon/
// Any route to the core counts, including the napi binding a main-only shim
// uses — omitting `requireRustGitBinding` here is what made this gate's first
// run accuse `skill-metadata` of a reverted cutover it had not reverted.
const DISPATCH =
  /tryOrcaDispatch|requireOrcaDispatch|dispatchToWasmCore|isOrcaDispatchReady|orcaDispatch\(|requireRustGitBinding/
const STATES = new Set(['crossed', 'retained', 'never'])

const git = (args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256e6,
    stdio: ['ignore', 'pipe', 'ignore']
  })
// The INDEX, not the working tree: it is exactly what a commit would contain,
// so a new file works as soon as it is staged, while the ~1,700 uncommitted
// files other sessions keep in this tree cannot redden the gate.
const headFile = (path) => {
  try {
    return git(['show', `:${path}`])
  } catch {
    try {
      return git(['show', `HEAD:${path}`])
    } catch {
      return null
    }
  }
}

const census = JSON.parse(
  headFile('config/cutover-census.json') ??
    readFileSync(join(ROOT, 'config/cutover-census.json'), 'utf8')
)
const onDisk = git(['ls-files', 'tools/parity/vectors/'])
  .split('\n')
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice('tools/parity/vectors/'.length, -'.json'.length))
  .sort()
const problems = []

function resolveImport(fromRepoPath, spec) {
  const base = normalize(join(dirname(fromRepoPath), spec))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (headFile(candidate) !== null) {
      return candidate
    }
  }
  return null
}

/** Does this module's adapter still reach the Rust core? */
function reachesCore(module) {
  const adapter = `tools/parity/dispatch/${module}.ts`
  const text = headFile(adapter)
  if (text === null) {
    return false
  }
  if (ORACLE.test(text)) {
    return true
  }
  const targets = [...text.matchAll(/from\s*'([^']+)'/g)]
    .map((m) => resolveImport(adapter, m[1]))
    .filter((t) => t && t.startsWith('src/'))
  return targets.some((t) => DISPATCH.test(headFile(t) ?? ''))
}

for (const module of onDisk) {
  if (!census.modules[module]) {
    problems.push(
      `${module}: no census entry — decide its terminal state in config/cutover-census.json`
    )
  }
}
for (const [module, entry] of Object.entries(census.modules)) {
  if (!onDisk.includes(module)) {
    problems.push(
      `${module}: census entry has no vector file — remove the entry or restore the module`
    )
    continue
  }
  if (!STATES.has(entry.state)) {
    problems.push(`${module}: state ${JSON.stringify(entry.state)} is not crossed/retained/never`)
    continue
  }
  if (entry.state !== 'crossed' && !(entry.reason ?? '').trim()) {
    problems.push(`${module}: ${entry.state} needs a reason`)
  }
  if (entry.state === 'crossed' && !reachesCore(module)) {
    problems.push(`${module}: claims crossed, but its adapter no longer reaches the core`)
  }
  if (entry.check) {
    const script = join(ROOT, entry.check)
    if (headFile(entry.check) === null) {
      problems.push(`${module}: check ${entry.check} does not exist`)
      continue
    }
    // A check that CRASHES and a check that reports "blocker cleared" both exit
    // non-zero, and conflating them is a gate that lies: the first run of this
    // gate called a refusal stale when the script had merely failed to load a
    // native addon. A deliberate `process.exit(1)` writes nothing to stderr; an
    // uncaught throw writes a stack trace. That is the discriminator.
    try {
      execFileSync(process.execPath, [script], { stdio: 'pipe' })
    } catch (error) {
      const stderr = String(error.stderr ?? '').trim()
      if (stderr) {
        problems.push(
          `${module}: its check ${entry.check} ERRORED — this is a broken check, not a cleared blocker. Fix the check.\n      ${stderr.split('\n')[0]}`
        )
      } else {
        problems.push(
          `${module}: its refusal is STALE — ${entry.check} exited non-zero, meaning the blocker it names has cleared. Re-check the module.`
        )
      }
    }
  }
}

const tally = {}
for (const entry of Object.values(census.modules)) {
  tally[entry.state] = (tally[entry.state] ?? 0) + 1
}
const summary = Object.entries(tally)
  .map(([k, v]) => `${v} ${k}`)
  .join(', ')
console.log(`[cutover-census] ${onDisk.length} modules — ${summary}`)

if (problems.length > 0) {
  console.error(`\n[cutover-census] ${problems.length} problem(s):`)
  for (const p of problems) {
    console.error(`  - ${p}`)
  }
  process.exit(1)
}
console.log('[cutover-census] every module has a terminal state and every refusal is still true.')
