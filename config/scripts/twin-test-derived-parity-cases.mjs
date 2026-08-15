#!/usr/bin/env node

// Does `pnpm parity` green mean the Rust port is faithful?
//
// No. It means the port agrees with its TypeScript twin ON THE VECTORS THAT
// EXIST. Batch 4 of the cutover found four modules whose Rust core diverges
// from the live twin on reachable production input while parity stayed green:
//
//   tab-title-resolution    the twin has kept native OpenCode titles since
//                           88068f55b (#9080); the core has no such branch, and
//                           not one of the 17 vectors carries an `OC | …` title.
//   synthetic-agent-title   the twin knows 8 agents, the core knows 5; the 13
//                           vectors name only the 4 they agree on.
//   mcp-env                 the twin drops oversized env maps, the core has no
//                           bounds; no vector is near the limits.
//
// Each was found by hand, by one agent, at the cost of a cutover slot. This
// finds them mechanically, and the missing inputs are already in the repo: THE
// TWIN'S OWN UNIT TESTS. The behaviours the vectors miss are the ones the twin
// grew after the port was taken, and a twin does not grow behaviour without
// growing a test — tab-title-resolution.test.ts has six `OC |` cases against the
// vector corpus's zero.
//
// HOW: run each twin's test file with the twin swapped for a recorder that wraps
// it, so every call the tests make is captured as (function, args, result) —
// real inputs and the twin's real answers, neither hand-authored nor guessed.
// Those become candidate vectors, orca-parity runs the Rust core over them, and
// any disagreement is a divergence the existing corpus cannot see.
//
// WHY THE RECORDED OUTPUT IS A SOUND ORACLE: it is the live twin's own return
// value for that call, captured in the same process. No transcription step can
// get it wrong. If Rust disagrees, either the port is stale or the twin moved —
// both are what this is looking for.
//
// THE ONE THING THAT HAD TO BE LEARNED, NOT ASSUMED: a vector's `input` is a
// JSON value and the twin is called positionally, so recorded args must be
// re-encoded into whatever shape the module's vectors use. Two conventions are
// in play across the corpus — `input` IS the single argument
// (`isStablePaneId`), or `input` is a named-argument object
// (`{tab, generatedTitlesEnabled, fallback}`). Guessing wrong produces vectors
// that mean one thing to the adapter and another to Rust, i.e. fabricated
// divergences. So the convention is MEASURED: phase A replays every EXISTING
// vector case through the module's own parity adapter with the recorder
// installed, which yields observed (input, args) pairs, and the convention is
// whichever one reproduces every pair. Neither fits => UNDERIVABLE, reported,
// never guessed at.
//
// WHAT IT CANNOT SEE, so a green run is not over-read:
//   * behaviour the twin's tests do not exercise either. This widens coverage
//     from the vector corpus to the unit corpus; it is not exhaustive.
//   * already cut-over modules — their twin holds no implementation to record.
//   * calls whose arguments are not JSON round-trippable (counted, never
//     silently dropped).
//
// The agreeing cases are the other half of the value: they are new vectors,
// derived rather than written, ready to widen the corpus permanently.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript-api'

import { prepareWorkDir, runRecording, writeRecorder } from './twin-call-recording.mjs'
import { REPO_ROOT } from './typescript-symbol-resolution.mjs'
const VECTORS_DIR = path.join(REPO_ROOT, 'tools', 'parity', 'vectors')
const ADAPTER_DIR = path.join(REPO_ROOT, 'tools', 'parity', 'dispatch')
const WORK_DIR = path.join(REPO_ROOT, 'tools', 'parity', '.twin-derived')
const SINK_FILE = path.join(WORK_DIR, 'recorded-calls.jsonl')
const ADAPTER_SINK_FILE = path.join(WORK_DIR, 'adapter-outputs.jsonl')
const CANDIDATE_DIR = path.join(WORK_DIR, 'vectors')
const RUST_OUTPUTS = path.join(WORK_DIR, 'rust_outputs.json')

const PATHS = {
  workDir: WORK_DIR,
  sinkFile: SINK_FILE,
  adapterSinkFile: ADAPTER_SINK_FILE,
  candidateDir: CANDIDATE_DIR
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Mirrors tools/parity/compare.ts (and the Rust `json_semantic_eq`): numbers by
 *  value, object keys order-insensitive, a missing key equal to an explicit
 *  `undefined`. Comparing raw JSON text instead would report key order as a
 *  divergence. */
function semanticEqual(a, b) {
  if (a === b) {
    return true
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || (Number.isNaN(a) && Number.isNaN(b))
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false
  }
  const aArray = Array.isArray(a)
  if (aArray !== Array.isArray(b)) {
    return false
  }
  if (aArray) {
    return a.length === b.length && a.every((value, index) => semanticEqual(value, b[index]))
  }
  const aKeys = Object.keys(a).filter((key) => a[key] !== undefined)
  const bKeys = Object.keys(b).filter((key) => b[key] !== undefined)
  return aKeys.length === bKeys.length && aKeys.every((key) => semanticEqual(a[key], b[key]))
}

/** A twin that returns a Uint8Array (the stream/screencast codecs) JSON-encodes
 *  as `{"0":1,…}` while Rust answers an array, so the raw recording would report
 *  every frame as a divergence. Typed arrays become plain arrays — and the
 *  normalization is not trusted, it is checked against each module's own adapter
 *  output in phase A. */
function normalizeOutput(value) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value)
  }
  if (Array.isArray(value)) {
    return value.map(normalizeOutput)
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeOutput(entry)])
    )
  }
  return value
}

function readVectorFiles() {
  const modules = []
  for (const name of fs.readdirSync(VECTORS_DIR).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, name), 'utf8'))
    if (!doc.module || !doc.source) {
      continue
    }
    modules.push({
      module: doc.module,
      source: doc.source,
      rustCrate: doc.rustCrate,
      cases: doc.cases ?? [],
      functions: [...new Set((doc.cases ?? []).map((c) => c.function))]
    })
  }
  return modules.sort((a, b) => a.module.localeCompare(b.module))
}

/** Parameter names, in order, for each ported function still declared in a twin.
 *
 *  A function whose parameters are destructured or rest has no name list to zip
 *  against; it is simply absent from the map, and the `single` convention can
 *  still carry it. */
function parameterNames(twinPath, functionNames) {
  const text = fs.readFileSync(twinPath, 'utf8')
  const sourceFile = ts.createSourceFile(twinPath, text, ts.ScriptTarget.Latest, true)
  const byFunction = new Map()
  const declared = new Set()
  const wanted = new Set(functionNames)

  const record = (name, parameters) => {
    if (!wanted.has(name) || declared.has(name)) {
      return
    }
    declared.add(name)
    const names = []
    for (const parameter of parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        return
      }
      names.push(parameter.name.text)
    }
    byFunction.set(name, names)
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      record(statement.name.text, statement.parameters)
      continue
    }
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (
        ts.isIdentifier(declaration.name) &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        record(declaration.name.text, initializer.parameters)
      }
    }
  }
  return { byFunction, declared }
}

/** Which encoding turns this function's positional args back into a vector
 *  `input`, decided only by what phase A actually observed. */
function inferConvention(pairs, parameters) {
  if (pairs.length === 0) {
    return { kind: 'none', why: 'no existing vector case reached the twin' }
  }
  const namedFits =
    Array.isArray(parameters) &&
    pairs.every(({ input, args }) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return false
      }
      if (Object.keys(input).some((key) => !parameters.includes(key))) {
        return false
      }
      return args.every(
        (arg, index) => index < parameters.length && same(arg, input[parameters[index]])
      )
    })
  if (namedFits) {
    return { kind: 'named', parameters }
  }
  if (pairs.every(({ input, args }) => args.length >= 1 && same(args[0], input))) {
    return { kind: 'single' }
  }
  return {
    kind: 'none',
    why: 'neither the named-argument nor the single-argument encoding reproduces the observed calls'
  }
}

/** Every key path a value contains, `a.b[].c` style.
 *
 *  Guards the one false-divergence class this instrument can manufacture. Some
 *  ports are deliberately LEAN: `toDetectedWorktree` spreads its input into its
 *  output, and its adapter says so outright — "vectors pass only
 *  { path, isMainWorktree } to match the lean Rust DetectedWorktree shape". The
 *  twin's own tests pass a whole Repo and Settings, so the twin's answer carries
 *  passthrough fields Rust was never given, and all 15 derived cases read as
 *  divergences when the port is fine. A derived case whose input reaches outside
 *  the key shape the corpus establishes is therefore reported separately, not
 *  counted as stale: the port may simply not model those fields. */
function keyPaths(value, prefix = '', into = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      keyPaths(entry, `${prefix}[]`, into)
    }
    return into
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${key}` : key
      into.add(next)
      keyPaths(entry, next, into)
    }
  }
  return into
}

function jsonSafe(value) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) {
      return { ok: false }
    }
    return { ok: true, value: JSON.parse(text), text }
  } catch {
    return { ok: false }
  }
}

function main() {
  prepareWorkDir(PATHS)

  const modules = readVectorFiles()
  const redirects = []
  const testFiles = []
  const skipped = []
  const eligible = []

  for (const moduleInfo of modules) {
    const twinPath = path.join(REPO_ROOT, moduleInfo.source)
    const testPath = twinPath.replace(/\.ts$/, '.test.ts')
    const adapterPath = path.join(ADAPTER_DIR, `${moduleInfo.module}.ts`)
    if (!fs.existsSync(twinPath)) {
      skipped.push({ module: moduleInfo.module, why: `twin missing (${moduleInfo.source})` })
      continue
    }
    const { byFunction, declared } = parameterNames(twinPath, moduleInfo.functions)
    const stillImplemented = moduleInfo.functions.filter((fn) => declared.has(fn))
    if (stillImplemented.length === 0) {
      skipped.push({
        module: moduleInfo.module,
        why: 'already cut over — the twin holds no ported implementation'
      })
      continue
    }
    if (!fs.existsSync(testPath)) {
      skipped.push({
        module: moduleInfo.module,
        why: 'the twin has no co-located unit test to record'
      })
      continue
    }
    if (!fs.existsSync(adapterPath)) {
      skipped.push({
        module: moduleInfo.module,
        why: 'no parity adapter, so the argument encoding cannot be measured'
      })
      continue
    }
    const recorderPath = writeRecorder(PATHS, moduleInfo.module, stillImplemented, twinPath)
    redirects.push([twinPath, recorderPath])
    testFiles.push(path.relative(REPO_ROOT, testPath))
    eligible.push({ ...moduleInfo, twinPath, adapterPath, byFunction, stillImplemented })
  }

  console.log(`[twin-derived] ${eligible.length} modules eligible, ${skipped.length} skipped`)
  const reasons = new Map()
  for (const entry of skipped) {
    const bucket = entry.why.split('(')[0].trim()
    reasons.set(bucket, (reasons.get(bucket) ?? 0) + 1)
  }
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${reason}`)
  }
  if (eligible.length === 0) {
    return 0
  }

  console.log(
    `[twin-derived] recording ${testFiles.length} twin test files + the convention replay`
  )
  const recording = runRecording(PATHS, { repoRoot: REPO_ROOT, redirects, testFiles, eligible })
  if (recording.status !== 0) {
    console.log(
      `[twin-derived] note: twin test run exited ${recording.status} (recording is still valid)`
    )
  }

  const calls = recording.calls
  const replayCalls = calls.filter((call) => call.replay)
  const twinCalls = calls.filter((call) => !call.replay)
  console.log(
    `[twin-derived] ${replayCalls.length} replay calls (convention evidence), ${twinCalls.length} twin-test calls`
  )

  const adapterByKey = new Map(
    recording.adapterOutputs.map((entry) => [
      `${entry.module}::${entry.fn}::${entry.caseIndex}`,
      entry.output
    ])
  )

  const conventions = new Map()
  const underivable = []
  for (const moduleInfo of eligible) {
    for (const fn of moduleInfo.stillImplemented) {
      const key = `${moduleInfo.module}::${fn}`
      const calls = replayCalls.filter(
        (call) => call.module === moduleInfo.module && call.fn === fn
      )
      const convention = inferConvention(
        calls.map((call) => ({ input: call.replay.input, args: call.args })),
        moduleInfo.byFunction.get(fn)
      )
      // The output side needs proving too: the recorder sees the twin's raw
      // return, the corpus holds whatever the adapter reports. If normalizing the
      // raw value does not reproduce the adapter's answer on every existing case,
      // this script cannot encode the twin's answers for that function and says
      // so rather than emitting cases whose `expected` means something else.
      const outputMismatch = calls.find((call) => {
        const adapter = adapterByKey.get(`${key}::${call.replay.caseIndex}`)
        return adapter !== undefined && !semanticEqual(normalizeOutput(call.result), adapter)
      })
      if (convention.kind !== 'none' && outputMismatch) {
        conventions.set(key, { kind: 'none' })
        underivable.push({
          module: moduleInfo.module,
          fn,
          why: "the twin's raw return does not normalize to the adapter's reported output"
        })
        continue
      }
      conventions.set(key, convention)
      if (convention.kind === 'none') {
        underivable.push({ module: moduleInfo.module, fn, why: convention.why })
      }
    }
  }

  // A vector marked `allowDivergence` is a fresh-reimplementation difference the
  // corpus already accepts; a derived case for the same function must not be
  // relabelled as a stale port.
  const intendedDivergence = new Set()
  const shapeEnvelope = new Map()
  for (const moduleInfo of eligible) {
    for (const testCase of moduleInfo.cases) {
      const key = `${moduleInfo.module}::${testCase.function}`
      if (testCase.allowDivergence) {
        intendedDivergence.add(key)
      }
      if (!shapeEnvelope.has(key)) {
        shapeEnvelope.set(key, new Set())
      }
      for (const keyPath of keyPaths(testCase.input)) {
        shapeEnvelope.get(key).add(keyPath)
      }
    }
  }
  if (underivable.length > 0) {
    console.log(
      `[twin-derived] ${underivable.length} functions UNDERIVABLE (their calls are dropped, not guessed):`
    )
    for (const entry of underivable.slice(0, 12)) {
      console.log(`    ${entry.module}::${entry.fn} — ${entry.why}`)
    }
  }

  const byModule = new Map()
  let unserializable = 0
  for (const call of twinCalls) {
    const convention = conventions.get(`${call.module}::${call.fn}`)
    if (!convention || convention.kind === 'none') {
      continue
    }
    let input
    if (convention.kind === 'single') {
      input = call.args[0]
    } else {
      input = {}
      for (const [index, name] of convention.parameters.entries()) {
        if (index < call.args.length) {
          input[name] = call.args[index]
        }
      }
    }
    const safeInput = jsonSafe(input)
    const safeOutput = jsonSafe(normalizeOutput(call.result))
    if (!safeInput.ok || !safeOutput.ok) {
      unserializable += 1
      continue
    }
    if (!byModule.has(call.module)) {
      byModule.set(call.module, { seen: new Set(), cases: [], twinOutputs: [] })
    }
    const bucket = byModule.get(call.module)
    const key = `${call.fn}::${safeInput.text}`
    if (bucket.seen.has(key)) {
      continue
    }
    bucket.seen.add(key)
    // `expected` is deliberately omitted: orca-parity golden-checks it and would
    // fail the run on the very divergences this exists to find. The twin's
    // answer is kept alongside and compared here.
    bucket.cases.push({
      function: call.fn,
      note: call.testName ? `twin test: ${call.testName}` : 'twin test',
      input: safeInput.value
    })
    bucket.twinOutputs.push(safeOutput.value)
  }

  for (const [moduleName, bucket] of byModule) {
    const moduleInfo = eligible.find((m) => m.module === moduleName)
    const existing = new Set(
      moduleInfo.cases.map((c) => `${c.function}::${JSON.stringify(c.input)}`)
    )
    bucket.novel = bucket.cases.filter(
      (c) => !existing.has(`${c.function}::${JSON.stringify(c.input)}`)
    ).length
    fs.writeFileSync(
      path.join(CANDIDATE_DIR, `${moduleName}.json`),
      `${JSON.stringify(
        {
          module: moduleName,
          source: moduleInfo.source,
          rustCrate: moduleInfo.rustCrate,
          cases: bucket.cases
        },
        null,
        2
      )}\n`
    )
  }
  console.log(
    `[twin-derived] ${byModule.size} modules produced cases (${unserializable} calls not JSON round-trippable)`
  )

  // The real Rust core over the derived corpus, the same way `pnpm parity` does:
  // same binary, offline via rust/vendor, RUSTFLAGS cleared because the repo
  // config's `-Z` verifier flags do not parse on the stable leg.
  const which = (tool) => {
    const r = spawnSync('rustup', ['which', tool, '--toolchain', 'stable'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : null
  }
  const cargoBin = which('cargo')
  const rustcBin = which('rustc')
  if (!cargoBin || !rustcBin) {
    console.error('[twin-derived] rustup stable unavailable; cannot run the Rust leg')
    return 1
  }
  const rust = spawnSync(
    cargoBin,
    [
      'run',
      '--quiet',
      '-p',
      'orca-parity',
      '--manifest-path',
      'rust/Cargo.toml',
      '--',
      CANDIDATE_DIR,
      RUST_OUTPUTS
    ],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, RUSTC: rustcBin, RUSTFLAGS: '', RUSTDOCFLAGS: '' }
    }
  )
  if (rust.status !== 0) {
    console.error(`[twin-derived] Rust leg failed (exit ${rust.status})`)
    console.error((rust.stderr || '').split('\n').slice(-25).join('\n'))
    return 1
  }
  console.log(`[twin-derived] ${(rust.stdout || '').trim().split('\n').pop()}`)

  const rustRuns = JSON.parse(fs.readFileSync(RUST_OUTPUTS, 'utf8'))
  const rustByKey = new Map(rustRuns.map((run) => [`${run.module}::${run.caseIndex}`, run]))

  const report = []
  for (const [moduleName, bucket] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) {
    const divergences = []
    const allowed = []
    const outOfShape = []
    let compared = 0
    let unreached = 0
    for (const [index, testCase] of bucket.cases.entries()) {
      const run = rustByKey.get(`${moduleName}::${index}`)
      if (!run) {
        unreached += 1
        continue
      }
      compared += 1
      if (semanticEqual(run.rustOutput, bucket.twinOutputs[index])) {
        continue
      }
      const divergence = {
        function: testCase.function,
        note: testCase.note,
        input: testCase.input,
        twin: bucket.twinOutputs[index],
        rust: run.rustOutput
      }
      const key = `${moduleName}::${testCase.function}`
      const envelope = shapeEnvelope.get(key) ?? new Set()
      const outside = [...keyPaths(testCase.input)].filter((keyPath) => !envelope.has(keyPath))
      if (intendedDivergence.has(key)) {
        allowed.push(divergence)
      } else if (outside.length > 0) {
        outOfShape.push({ ...divergence, outside: outside.slice(0, 6) })
      } else {
        divergences.push(divergence)
      }
    }
    report.push({
      module: moduleName,
      derived: bucket.cases.length,
      novel: bucket.novel,
      compared,
      unreached,
      divergences,
      allowed,
      outOfShape
    })
  }

  const reportPath = path.join(WORK_DIR, 'report.json')
  fs.writeFileSync(reportPath, `${JSON.stringify({ report, skipped, underivable }, null, 2)}\n`)

  const stale = report.filter((r) => r.divergences.length > 0)
  console.log('')
  console.log('  module                              derived  novel  stale  out-of-shape')
  for (const row of report) {
    console.log(
      `  ${row.module.padEnd(34)} ${String(row.derived).padStart(6)} ${String(row.novel).padStart(6)} ` +
        `${(row.divergences.length || '-').toString().padStart(6)} ${(row.outOfShape.length || '-').toString().padStart(13)}`
    )
  }
  console.log('')
  for (const row of stale) {
    console.log(`STALE ${row.module} (${row.divergences.length})`)
    for (const divergence of row.divergences.slice(0, 3)) {
      console.log(`  ${divergence.function} — ${divergence.note}`)
      console.log(`    input ${JSON.stringify(divergence.input).slice(0, 180)}`)
      console.log(`    twin  ${JSON.stringify(divergence.twin).slice(0, 180)}`)
      console.log(`    rust  ${JSON.stringify(divergence.rust).slice(0, 180)}`)
    }
    if (row.divergences.length > 3) {
      console.log(`  … ${row.divergences.length - 3} more`)
    }
  }
  console.log('')
  const outOfShapeModules = report.filter((r) => r.outOfShape.length > 0)
  if (outOfShapeModules.length > 0) {
    console.log(
      'OUT-OF-SHAPE (derived input reaches past the corpus key shape; the port may be lean by design, review before believing):'
    )
    for (const row of outOfShapeModules) {
      console.log(
        `  ${row.module} (${row.outOfShape.length}) — e.g. ${row.outOfShape[0].function} carries ${row.outOfShape[0].outside.join(', ')}`
      )
    }
    console.log('')
  }
  console.log(
    `[twin-derived] ${report.length} modules compared, ${stale.length} STALE, ` +
      `${outOfShapeModules.length} out-of-shape, ` +
      `${report.reduce((sum, r) => sum + r.novel, 0)} novel cases the vector corpus does not have`
  )
  console.log(`[twin-derived] full report: ${path.relative(REPO_ROOT, reportPath)}`)
  return 0
}

process.exitCode = main()
