#!/usr/bin/env node
// Launch the built app and prove it actually STARTS.
//
// This exists because three separate defects shipped while every unit and
// integration suite was green, and all three were invisible to them:
//
//   1. A Rust panic on the web renderer's first frame (std::time::Instant::now()
//      is unsupported on wasm32). The panic poisons the wasm-bindgen RefCell, so
//      the visible symptom was an unrelated "recursive use of an object" throw.
//   2. A circular-import TDZ that killed main-process load outright
//      ("<fn> is not a function"), order-dependent enough that the same source
//      produced a working bundle and a broken one minutes apart.
//   3. A stale Swift module cache that failed the package build after a repo
//      directory rename.
//
// Unit tests exercise modules; this exercises the seam they cannot reach — the
// wasm target, the bundler's module order, and the packaged entrypoint. It is
// deliberately cheap: launch, wait for the window, assert no renderer error and
// no wasm panic, exit.
//
// Usage: node config/scripts/smoke-launch-app.mjs [--timeout-ms 45000]
// Requires `out/main/index.js` (pnpm run build:electron-vite).

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const mainPath = path.join(repoRoot, 'out', 'main', 'index.js')

function readArg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index < 0 || !process.argv[index + 1]) {
    return fallback
  }
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const settleMs = readArg('--settle-ms', 12000)

// Why: the unpackaged bundle is NOT the shipped artifact. Whole failure classes
// only exist once packaged — app.isPackaged-gated startup code, asar resolution,
// Resources/node_modules — and one of them (a main entry calling a function its
// sibling entry no longer exported) shipped an app that could not open a window
// while this smoke, driving out/main/index.js, stayed green.
function readPathArg(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}
const packagedApp = readPathArg('--app')

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.log('[smoke-launch] unsupported platform; skipping')
  process.exit(0)
}
// A packaged .app is driven through its own binary, so Electron reports itself
// packaged and the asar layout is the real one.
const packagedBinary = packagedApp
  ? path.join(packagedApp, 'Contents', 'MacOS', path.basename(packagedApp).replace(/\.app$/, ''))
  : null

if (packagedBinary && !existsSync(packagedBinary)) {
  console.error(`[smoke-launch] no executable at ${packagedBinary}`)
  process.exit(1)
}
if (!packagedBinary && !existsSync(mainPath)) {
  console.error(
    `[smoke-launch] ${path.relative(repoRoot, mainPath)} is missing — run \`pnpm run build:electron-vite\` first.`
  )
  process.exit(1)
}

// Why check first: Electron's single-instance lock is keyed on userData, so a
// second instance quits instead of opening a window — and this smoke then fails
// with a bare launch timeout that reads exactly like the app being broken. That
// misdiagnosis cost real time; name the cause instead.
function runningOrcaInstances() {
  try {
    const out = execFileSync('pgrep', ['-fl', 'Orca ALab Edition.app/Contents/MacOS'], {
      encoding: 'utf8'
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

const alreadyRunning = runningOrcaInstances()
if (alreadyRunning.length > 0) {
  console.error(
    '[smoke-launch] refusing to run: another Orca instance already holds the ' +
      'single-instance lock, so the instance this launches would exit without a window.'
  )
  for (const line of alreadyRunning.slice(0, 3)) {
    console.error(`  - ${line.slice(0, 120)}`)
  }
  console.error('  Quit it first (the smoke measures a cold launch, not a second instance).')
  process.exit(1)
}

// A Rust panic reaches JS as an "unreachable" trap; the PANIC MESSAGE is what
// names the real fault, so match it directly rather than the aliasing symptom.
const FATAL = [
  /panicked at/i,
  /recursive use of an object/i,
  /is not a function/i,
  /Cannot find module/i,
  /App threw an error during load/i
]

const failures = []

// A main bundle that throws during load never opens a window, so `launch` just
// waits. Bound it and treat the timeout as the failure it is — Playwright's call
// log carries the real stderr ("App threw an error during load", the TypeError,
// the stack), which is exactly what a reader needs.
let app
try {
  app = await electron.launch({
    ...(packagedBinary ? { executablePath: packagedBinary, args: [] } : { args: [mainPath] }),
    cwd: repoRoot,
    env: { ...process.env, ORCA_ALLOW_NO_TELEMETRY: '1' },
    timeout: readArg('--launch-timeout-ms', 60000)
  })
} catch (error) {
  const detail = String(error)
  const loadError = detail
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*\[pid=\d+\]\[err\]\s*/, '').trim())
    .filter((line) => /error|throw|Error:/i.test(line) && !line.startsWith('at '))
    .slice(0, 6)
  console.error('[smoke-launch] FAILED — the app never opened a window:')
  for (const line of loadError.length > 0 ? loadError : [detail.split('\n')[0]]) {
    console.error(`  - ${line}`)
  }
  process.exit(1)
}
const window = await app.firstWindow()
// Bind BEFORE waiting: boot-time errors fire early and are otherwise missed.
window.on('pageerror', (error) => failures.push(`pageerror: ${String(error).split('\n')[0]}`))
// Why: a preload that fails to load is SILENT — Electron reports it only here, the
// renderer just sees window.api === undefined, and the error boundary it lands in
// still renders text, so the mount checks below pass. This is how a broken preload
// shipped once already.
window.on('preloaderror', (error) => failures.push(`preload: ${String(error).split('\n')[0]}`))
window.on('console', (message) => {
  const text = message.text()
  if (message.type() === 'error' && FATAL.some((pattern) => pattern.test(text))) {
    failures.push(`console: ${text.split('\n')[0]}`)
  }
})

await window.waitForLoadState('domcontentloaded')
await window.waitForTimeout(settleMs)

const mounted = await window.evaluate(() => ({
  childCount: document.body?.childElementCount ?? 0,
  hasText: (document.body?.innerText ?? '').trim().length > 0,
  // The preload bridge: undefined means Electron loaded no preload at all.
  hasBridge: typeof window.api === 'object' && window.api !== null,
  // The error boundary renders text and children, so the checks above cannot see it.
  crashed: (document.body?.innerText ?? '').includes('hit a renderer error')
}))

await app.close()

if (!mounted.hasText || mounted.childCount === 0) {
  failures.push('renderer mounted nothing — blank window')
}

if (!mounted.hasBridge) {
  failures.push('window.api is undefined — the preload bridge did not load')
}

if (mounted.crashed) {
  failures.push('renderer rendered its error boundary instead of the app shell')
}

if (failures.length > 0) {
  console.error('[smoke-launch] FAILED — the app does not start cleanly:')
  for (const failure of failures.slice(0, 10)) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log('[smoke-launch] ok — the app launches, the renderer mounts, no panics or load errors.')
