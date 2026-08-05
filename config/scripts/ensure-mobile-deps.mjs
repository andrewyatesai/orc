#!/usr/bin/env node

// `mobile/` is deliberately NOT a pnpm workspace package: it pins TypeScript 6 so
// Expo/Metro can keep using the JS compiler API, while the root is on TypeScript 7.
// Nothing therefore installs mobile/node_modules, and `tsc` run there resolves the
// root's hoisted TypeScript 7 instead — which rejects mobile's `baseUrl` with
// TS5102 and fails `pnpm run typecheck` on any clean checkout. Install mobile's own
// tree first so its pinned toolchain is the one that runs.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const projectDir = resolve(import.meta.dirname, '../..')
const mobileDir = resolve(projectDir, 'mobile')
// The pinned compiler itself is the marker: a bare node_modules can predate the
// pin, and it is the one binary the failure mode is about.
const pinnedTypescript = resolve(mobileDir, 'node_modules/typescript/package.json')

if (existsSync(pinnedTypescript)) {
  process.exit(0)
}

console.log(
  '[ensure-mobile-deps] mobile/node_modules is missing its pinned toolchain — installing…'
)
const install = spawnSync('pnpm', ['--dir', mobileDir, 'install', '--frozen-lockfile'], {
  stdio: 'inherit',
  cwd: projectDir
})

if (install.status !== 0) {
  console.error(
    '[ensure-mobile-deps] `pnpm --dir mobile install --frozen-lockfile` failed ' +
      `(exit ${install.status}). mobile/ installs separately from the root workspace.`
  )
  process.exit(install.status ?? 1)
}
