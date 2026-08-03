#!/usr/bin/env node
/**
 * The CLI and the Electron main bundle are built by two different compilers into
 * ONE directory: `build:cli` runs tsc into `out/`, and electron-vite cleans and
 * rebuilds `out/main`. Whichever runs last wins.
 *
 * So any `src/main/**` module the CLI imports has to be an electron-vite entry,
 * or a plain `pnpm dev` silently deletes it and every `orca` command dies with
 * "Cannot find module '../../main/daemon/client'" — at runtime, long after the
 * build that broke it reported success.
 *
 * This recomputes the required set from source and fails if the config drifts.
 * It reads source rather than build output so it works on a clean checkout.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const CLI_ROOTS = ['src/cli', 'src/shared']
const CONFIG_PATH = join(repoRoot, 'electron.vite.config.ts')

/** Type-only imports are erased by tsc, so they never become a runtime require. */
const TYPE_ONLY = /^\s*import\s+type\b/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

const required = new Map()
for (const root of CLI_ROOTS) {
  for (const file of walk(join(repoRoot, root))) {
    const source = readFileSync(file, 'utf8')
    for (const line of source.split('\n')) {
      if (TYPE_ONLY.test(line)) {
        continue
      }
      const match = line.match(/from\s+'((?:\.\.\/)+main\/[^']+)'/)
      if (!match) {
        continue
      }
      const spec = match[1].replace(/^(?:\.\.\/)+main\//, '')
      if (!required.has(spec)) {
        required.set(spec, file.slice(repoRoot.length + 1))
      }
    }
  }
}

const config = readFileSync(CONFIG_PATH, 'utf8')
// Entries are written both inline and wrapped across lines, so the argument may
// be separated from `resolve(` by whitespace.
const declared = new Set(
  [...config.matchAll(/resolve\(\s*'src\/main\/([^']+)\.ts'\s*\)/g)].map((m) => m[1])
)

const missing = [...required.entries()].filter(([spec]) => !declared.has(spec))
if (missing.length > 0) {
  console.error(
    'check-cli-main-entry-coverage: the CLI imports src/main modules that electron-vite does not emit.\n' +
      'electron-vite cleans out/main, so these get deleted on the next `pnpm dev` and the CLI\n' +
      'breaks at runtime with "Cannot find module". Add each to the `main.build.rollupOptions.input`\n' +
      'map in electron.vite.config.ts:\n'
  )
  for (const [spec, importer] of missing) {
    console.error(`  '${spec}': resolve('src/main/${spec}.ts')   // imported by ${importer}`)
  }
  process.exit(1)
}

console.log(
  `check-cli-main-entry-coverage OK — ${required.size} src/main module(s) imported by the CLI, all emitted as electron-vite entries.`
)
