#!/usr/bin/env node
// What it would COST to cut `quick-open-filter`'s three per-file predicates over
// to the Rust core, and the check that says when that stops being true.
//
// `shouldIncludeQuickOpenPath`, `shouldExcludeQuickOpenRelPath` and
// `normalizeQuickOpenRgLine` are the only exports in that module the Rust port
// reproduces exactly, so "why are they still TypeScript" has to be a number, not
// an opinion. They run ONCE PER LISTED FILE on a path that lists with no
// maxResults and dies on a hard 10s timeout, so the number that decides is the
// per-item one:
//
//   node config/scripts/quick-open-filter-crossing-cost.mjs
//   node config/scripts/quick-open-filter-crossing-cost.mjs --check
//
// `--check` FAILS when crossing becomes cheap enough that the refusal is stale —
// that is the trigger to cut them over, and it is the reason this is a script and
// not a paragraph. It compares RATIOS, never wall-clock absolutes, so a loaded
// laptop moves both sides together and the verdict does not move.
//
// It also re-derives, against BOTH shipped artifacts, that the fourth export
// `buildExcludePathPrefixes` still disagrees with the core in its three classes.
// The correctness half of all four lives in
// `src/shared/quick-open-filter-crossing.test.ts`; this script owns the cost half
// and the both-artifacts half.
import { createRequire } from 'node:module'
import { hrtime } from 'node:process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const url = (relative) => fileURLToPath(new URL(relative, import.meta.url))

// Why bundle instead of importing the .ts: node's type stripping does not resolve
// the repo's extensionless relative imports, and bundling measures the shape the
// app ships. Same idiom as dispatch-payload-codec-benchmark.mjs.
async function loadTs(entry) {
  const bundled = await build({
    entryPoints: [url(entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['node:path']
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
}

const twin = await loadTs('../../src/shared/quick-open-filter.ts')
const { encodeDispatchPayload } = await loadTs('../../src/shared/dispatch-payload-codec.ts')

// Both shipped artifacts, because a cost that only holds on one of them is not a
// reason: main and cli reach the core through napi, the SSH relay through wasm.
const ARTIFACTS = []

// The COMMITTED wasm, i.e. the base64 module the vitest seam setup binds, not the
// build-output `.wasm` — this script has to run from a fresh checkout.
const wasm = await import(`${repoRoot}src/relay/wasm/orca_git_wasm.js`)
const { ORCA_GIT_WASM_BASE64 } = await loadTs('../../src/relay/wasm/orca_git_wasm_bg.wasm.base64.ts')
wasm.initSync({ module: Buffer.from(ORCA_GIT_WASM_BASE64, 'base64') })

// napi is a BUILD ARTIFACT (`pnpm run build:terminal-addon`), so it may be absent.
// Skipped with a line rather than a crash — a missing addon must not read as a
// verdict about the crossing.
try {
  const napi = require(`${repoRoot}native/orca-node/orca_node.node`)
  ARTIFACTS.push(['napi (main, cli)', (fn, json) => napi.orcaDispatch('quick-open-filter', fn, json)])
} catch {
  console.log('[skip] native/orca-node/orca_node.node is not built — wasm only\n')
}
ARTIFACTS.push(['wasm (SSH relay)', (fn, json) => wasm.orcaDispatch('quick-open-filter', fn, json)])

// A realistic path mix, not a synthetic one: the shapes rg actually emits are
// mostly unblocked source paths several segments deep, which is the case where
// the twin's segment walk is at its most expensive and the crossing at its most
// favourable. Stacking the corpus against the refusal is the point.
const PATHS = [
  'src/renderer/src/components/quick-open-file-list.ts',
  'src/shared/quick-open-filter.ts',
  'README.md',
  'rust/crates/orca-core/src/quick_open_filter.rs',
  'docs/design/share-quick-open-file-listing.md',
  'packages/app/src/index.ts',
  '.github/workflows/ci.yml',
  'node_modules/left-pad/index.js',
  'src/main/ipc/filesystem-list-files.ts',
  'tests/e2e/fixtures/Café/🚀/deep/nested/file.spec.ts'
]
const PREFIXES = ['packages/app']
const MODE = { kind: 'cwd-relative' }

const SUBJECTS = [
  {
    name: 'shouldIncludeQuickOpenPath',
    twin: (path) => twin.shouldIncludeQuickOpenPath(path),
    payload: (path) => ({ path })
  },
  {
    name: 'shouldExcludeQuickOpenRelPath',
    twin: (path) => twin.shouldExcludeQuickOpenRelPath(path, PREFIXES),
    payload: (path) => ({ relPath: path, excludePathPrefixes: PREFIXES })
  },
  {
    name: 'normalizeQuickOpenRgLine',
    twin: (path) => twin.normalizeQuickOpenRgLine(`./${path}`, MODE),
    payload: (path) => ({ rawLine: `./${path}`, outputMode: MODE })
  }
]

const ITERATIONS = 40_000

function nanosPerCall(fn, iterations) {
  for (let i = 0; i < 4_000; i++) {
    fn(PATHS[i % PATHS.length])
  }
  const start = hrtime.bigint()
  for (let i = 0; i < iterations; i++) {
    fn(PATHS[i % PATHS.length])
  }
  return Number(hrtime.bigint() - start) / iterations
}

// The crossing exactly as a shim would do it: the REAL codec (its object walk and
// its lone-surrogate scan are not optional), the real entry, the real decode.
function crossing(subject, dispatch) {
  return (path) =>
    JSON.parse(dispatch(subject.name, encodeDispatchPayload(subject.payload(path))))
}

const check = process.argv.includes('--check')
const totals = new Map(ARTIFACTS.map(([label]) => [label, 0]))
let twinTotal = 0

console.log(
  'export'.padEnd(32),
  'twin'.padStart(10),
  ...ARTIFACTS.map(([label]) => label.padStart(22))
)
for (const subject of SUBJECTS) {
  const twinNs = nanosPerCall(subject.twin, ITERATIONS)
  twinTotal += twinNs
  const columns = [subject.name.padEnd(32), `${twinNs.toFixed(0)} ns`.padStart(10)]
  for (const [label, dispatch] of ARTIFACTS) {
    const crossedNs = nanosPerCall(crossing(subject, dispatch), ITERATIONS)
    totals.set(label, totals.get(label) + crossedNs)
    columns.push(`${crossedNs.toFixed(0)} ns ${(crossedNs / twinNs).toFixed(1)}x`.padStart(22))
  }
  console.log(columns.join(' '))
}

console.log(`\nall three, per listed file: twin ${twinTotal.toFixed(0)} ns`)
// A real $HOME with this module's own blocklist globs applied emits ~1.5M lines
// in ~7.7s of rg — already most of the hard 10s per-pass timeout the blocklist
// exists to avoid. Projecting the per-item delta onto that is the whole argument.
const HOME_SCAN_LINES = 1_500_000
for (const [label, crossedNs] of totals) {
  const added = crossedNs - twinTotal
  console.log(
    `  ${label.padEnd(18)} ${crossedNs.toFixed(0)} ns (${(crossedNs / twinTotal).toFixed(1)}x)` +
      `  -> +${((added * HOME_SCAN_LINES) / 1e9).toFixed(2)}s per pass on a ${(HOME_SCAN_LINES / 1e6).toFixed(1)}M-line scan`
  )
}

// The three classes that keep buildExcludePathPrefixes in TypeScript, re-derived
// against both artifacts rather than quoted.
const REFUSAL_CLASSES = [
  {
    klass: '1 UNC `//` root read as POSIX',
    rootPath: '//Server/Share/Repo',
    excludePaths: ['//server/share/repo/packages/app']
  },
  {
    klass: '2 relative() resolves against process.cwd()',
    rootPath: 'C:\\repo',
    excludePaths: ['packages/app']
  },
  {
    klass: '3 full-Unicode toLowerCase vs eq_ignore_ascii_case',
    rootPath: 'C:\\РЕПО',
    excludePaths: ['C:\\репо\\packages\\app']
  },
  {
    klass: '3 cross-drive relative() returns the RESOLVED path',
    rootPath: 'C:\\repo',
    excludePaths: ['D:\\repo\\a\\..\\b']
  }
]

console.log('\nbuildExcludePathPrefixes — still disagrees, per class:')
let agreements = 0
for (const row of REFUSAL_CLASSES) {
  const twinAnswer = JSON.stringify(twin.buildExcludePathPrefixes(row.rootPath, row.excludePaths))
  const answers = ARTIFACTS.map(([label, dispatch]) => {
    const crossed = dispatch(
      'buildExcludePathPrefixes',
      encodeDispatchPayload({ rootPath: row.rootPath, excludePaths: row.excludePaths })
    )
    if (crossed === twinAnswer) {
      agreements += 1
    }
    return `${label.split(' ')[0]}=${crossed}`
  })
  console.log(`  class ${row.klass}\n    twin=${twinAnswer}  ${answers.join('  ')}`)
}

if (!check) {
  process.exit(0)
}

const failures = []
// The refusal is stale when a crossing stops costing materially more than the
// body it replaces. 2.0x is deliberately generous against the observed 5-9x: it
// fires on a design change (a batched arm, a cheaper entry), not on noise.
const STALE_BELOW_RATIO = 2.0
for (const [label, crossedNs] of totals) {
  const ratio = crossedNs / twinTotal
  if (ratio < STALE_BELOW_RATIO) {
    failures.push(
      `${label}: crossing the three now costs ${ratio.toFixed(2)}x the TypeScript bodies, under the ${STALE_BELOW_RATIO}x that keeps them in TypeScript — re-run the cut-over`
    )
  }
}
if (agreements > 0) {
  failures.push(
    `buildExcludePathPrefixes now AGREES with a shipped core on ${agreements} of the ${REFUSAL_CLASSES.length * ARTIFACTS.length} class rows — the port gap closed, so revisit the refusal`
  )
}

if (failures.length > 0) {
  console.error(`\nthe quick-open-filter refusal has gone stale:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nrefusal still holds.')
