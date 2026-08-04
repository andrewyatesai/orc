#!/usr/bin/env node

// The orchestration store's raw-SQL seam (`rawExec` / `rawQueryJson`, reached via
// orchestration-sqlite-probe.ts) exists so fork specs can seed tables, read
// EXPLAIN QUERY PLAN and assert on sqlite_master against an in-memory database
// that no second connection can attach to. It runs arbitrary SQL, so production
// code must always go through a typed store method. Documentation alone does not
// hold that line — this gate does.
//
// Usage: node config/scripts/check-orchestration-raw-sql-seam.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const ROOTS = ['src', 'tools', 'tests']
const SEAM = /\brawExec\s*\(|\brawQueryJson\s*\(|orchestration-sqlite-probe/

// The seam's own definition, its napi declaration, and anything that is a test.
const ALLOWED =
  /(\.test\.[cm]?[jt]sx?$)|(-test-fixture\.ts$)|(\/__tests__\/)|(orchestration-sqlite-probe\.ts$)|(rust-orchestration-store-binding\.ts$)/

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
      continue
    }
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      yield* walk(path)
    } else if (/\.[cm]?[jt]sx?$/.test(path)) {
      yield path
    }
  }
}

const violations = []
for (const root of ROOTS) {
  let base
  try {
    base = statSync(join(ROOT, root))
  } catch {
    continue
  }
  if (!base.isDirectory()) {
    continue
  }
  for (const path of walk(join(ROOT, root))) {
    const rel = relative(ROOT, path)
    if (ALLOWED.test(rel)) {
      continue
    }
    const source = readFileSync(path, 'utf8')
    if (!SEAM.test(source)) {
      continue
    }
    for (const [index, line] of source.split('\n').entries()) {
      if (SEAM.test(line)) {
        violations.push(`${rel}:${index + 1}: ${line.trim()}`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    '[check-raw-sql-seam] the orchestration raw-SQL seam is reachable from non-test code:'
  )
  for (const violation of violations) {
    console.error(`  - ${violation}`)
  }
  console.error('  use a typed OrchestrationDb method, or add the query to orca-runtime.')
  process.exit(1)
}

console.log('[check-raw-sql-seam] ok — raw-SQL seam is confined to tests and tooling.')
