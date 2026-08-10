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
// The missing-require check always exits 1 — "gone" is never advisory. The
// STALENESS check is advisory by default (exit 0) so the script can be run
// anywhere mid-build without failing; `--strict` makes it a gate.
//
// `pnpm run check:build-output` passes --strict. It used to not, which meant the
// staleness finding — the entire reason this file exists, per the header above —
// printed its diagnosis and exited 0. A `check:` script that reports a violation
// and succeeds is not a gate. Running it bare is still the advisory mode.
//
// Usage: node config/scripts/check-build-output-consistency.mjs [--strict]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

// Why this runs BEFORE the mtime heuristic: the real failure is not "old", it is
// "gone". `build:electron-vite` REPLACES out/main with its bundle, deleting the
// tsc-emitted files out/cli requires (out/main/daemon/client.js and friends), and
// a rebuild inside the tolerance window below leaves that invisible. Resolve the
// CLI's actual cross-tree requires instead of guessing from timestamps.
const cliDir = path.join(repoRoot, 'out', 'cli')
const CROSS_TREE_REQUIRE = /require\(["'](\.\.\/[^"']*\/main\/[^"']+)["']\)/g
const missingTargets = new Map()
const walk = (dir) => {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      walk(full)
    } else if (item.name.endsWith('.js')) {
      for (const match of readFileSync(full, 'utf8').matchAll(CROSS_TREE_REQUIRE)) {
        const resolved = path.resolve(path.dirname(full), match[1])
        const found = existsSync(resolved) || existsSync(`${resolved}.js`)
        if (!found) {
          missingTargets.set(path.relative(repoRoot, resolved), path.relative(repoRoot, full))
        }
      }
    }
  }
}
if (existsSync(cliDir)) {
  walk(cliDir)
}
if (missingTargets.size > 0) {
  console.error('[check-build-output] the built CLI requires files that out/main no longer has:')
  for (const [target, importer] of missingTargets) {
    console.error(`  - ${target} (required by ${importer})`)
  }
  console.error('  A bundled main build replaced them. Fix: pnpm run build:cli')
  process.exit(1)
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
