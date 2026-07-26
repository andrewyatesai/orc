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

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.log('[smoke-launch] unsupported platform; skipping')
  process.exit(0)
}
if (!existsSync(mainPath)) {
  console.error(
    `[smoke-launch] ${path.relative(repoRoot, mainPath)} is missing — run \`pnpm run build:electron-vite\` first.`
  )
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
    args: [mainPath],
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
  hasText: (document.body?.innerText ?? '').trim().length > 0
}))

await app.close()

if (!mounted.hasText || mounted.childCount === 0) {
  failures.push('renderer mounted nothing — blank window')
}

if (failures.length > 0) {
  console.error('[smoke-launch] FAILED — the app does not start cleanly:')
  for (const failure of failures.slice(0, 10)) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log('[smoke-launch] ok — the app launches, the renderer mounts, no panics or load errors.')
