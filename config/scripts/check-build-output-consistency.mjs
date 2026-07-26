#!/usr/bin/env node
// Warn when `out/` is internally inconsistent.
//
// `build:electron-vite` rebuilds out/main, out/preload and out/renderer but NOT
// out/cli — that is a separate `build:cli` step. Iterating with the fast path
// therefore leaves a NEWER main bundle beside a STALE CLI, and the tests that
// drive the built CLI fail with things like
//
//   Error: Cannot find module '../../main/daemon/client'
//
// which points at a module path rather than at the stale artifact that caused it.
// This names the real problem and the one-line fix.
//
// Advisory by default (exit 0) so it can be run anywhere; `--strict` makes it a
// gate. Usage: node config/scripts/check-build-output-consistency.mjs [--strict]

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const strict = process.argv.includes('--strict')

// Each entry: a build output, and the pnpm script that regenerates it.
const OUTPUTS = [
  {
    label: 'main',
    file: path.join(repoRoot, 'out', 'main', 'index.js'),
    script: 'build:electron-vite'
  },
  { label: 'cli', file: path.join(repoRoot, 'out', 'cli', 'index.js'), script: 'build:cli' }
]

const present = OUTPUTS.filter((entry) => existsSync(entry.file))
if (present.length < 2) {
  console.log('[check-build-output] out/ is not fully built yet; nothing to compare.')
  process.exit(0)
}

const stamped = present.map((entry) => ({ ...entry, mtimeMs: statSync(entry.file).mtimeMs }))
const newest = stamped.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b))

// A tolerance so a single full build (whose steps run minutes apart) never trips
// this — only a genuinely skipped step does.
const TOLERANCE_MS = 30 * 60 * 1000
const stale = stamped.filter((entry) => newest.mtimeMs - entry.mtimeMs > TOLERANCE_MS)

if (stale.length === 0) {
  console.log('[check-build-output] ok — out/ artifacts are from the same build.')
  process.exit(0)
}

const ageMinutes = (entry) => Math.round((newest.mtimeMs - entry.mtimeMs) / 60000)
const staleList = stale
  .map((entry) => `out/${entry.label} (by ${ageMinutes(entry)} min)`)
  .join(', ')
const fix = stale.map((entry) => entry.script).join(' && pnpm run ')
console.error(
  `[check-build-output] out/ is inconsistent: out/${newest.label} is newer than ${staleList}.
  Tests that drive a stale artifact fail with confusing module-resolution errors.
  Fix: pnpm run ${fix}`
)
process.exit(strict ? 1 : 0)
