// @proves-gate-fires check:code-quality:changed
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const GATE_MODULES = ['check-changed-code-quality.mjs', 'git-pull-request-diff-base.mjs']
const OXLINT_CONFIGS = [
  'oxlint-code-quality.json',
  'oxlint-code-quality-type-aware.json',
  'oxlint-react-doctor.json'
]
const CHANGED_FILE = path.join('src', 'changed-module.ts')

// Committed as-is and never edited: a max-params violation the gate must keep ignoring,
// so a rejection below can only come from a line the working tree added.
const PREEXISTING_DEBT = `export function legacyWideSignature(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
): number {
  return a + b + c + d + e + f
}
`
const CLEAN_ADDITION = `
export function addedNarrowSignature(a: number, b: number): number {
  return a + b
}
`
const sandboxes = []

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=orca', '-c', 'user.email=orca@example.test', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

/**
 * A throwaway repo the gate can diff: one commit on `main` (the base it falls back to)
 * plus an uncommitted edit, since a `:changed` gate sees nothing without both.
 */
async function createSandbox() {
  if (!existsSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'oxlint'))) {
    throw new Error('Install dependencies first: the gate shells out to `pnpm exec oxlint`.')
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-changed-quality-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, 'config', 'oxlint-plugins'), { recursive: true })
  await mkdir(path.join(root, 'src'), { recursive: true })
  await Promise.all([
    ...GATE_MODULES.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    ),
    ...OXLINT_CONFIGS.map((name) =>
      copyFile(path.join(REPO_ROOT, 'config', name), path.join(root, 'config', name))
    ),
    copyFile(
      path.join(REPO_ROOT, 'config', 'oxlint-plugins', 'app-store-performance.mjs'),
      path.join(root, 'config', 'oxlint-plugins', 'app-store-performance.mjs')
    ),
    // `pnpm exec oxlint` needs a package to run in and a bin to find; both scans also
    // load js plugins (app-store-performance, react-doctor) out of node_modules.
    symlink(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules')),
    writeFile(path.join(root, '.gitignore'), 'node_modules\n'),
    writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'changed-code-quality-fixture', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`
    ),
    writeFile(path.join(root, CHANGED_FILE), PREEXISTING_DEBT)
  ])

  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture')
  await writeFile(path.join(root, CHANGED_FILE), PREEXISTING_DEBT + CLEAN_ADDITION)

  const script = path.join(scriptDir, GATE_MODULES[0])
  return {
    root,
    // The gate reads added lines, so a plant has to arrive as an uncommitted edit.
    addLines: (source) => writeFile(path.join(root, CHANGED_FILE), PREEXISTING_DEBT + source),
    addFile: (name, source) => writeFile(path.join(root, 'src', name), source),
    accepts: () => assertGateAccepts({ script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script, cwd: root, violation, expectMessage })
  }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:code-quality:changed rejects findings on the lines a change added', () => {
  it('fails on a max-params violation the working tree introduced', async () => {
    const sandbox = await createSandbox()
    // Passing here is load-bearing twice: oxlint really ran, and it declined to charge
    // this change for the identical violation sitting on the committed lines.
    sandbox.accepts()

    await sandbox.addLines(`
export function addedWideSignature(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
): number {
  return a + b + c + d + e + f
}
`)

    sandbox.rejects(
      'a six-parameter function on an added line',
      "eslint(max-params): Function 'addedWideSignature' has too many parameters (6). Maximum allowed is 5."
    )
  })

  it('fails on a floating promise, which only the type-aware scan can see', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.addLines(`
async function addedAsyncWork(): Promise<void> {}

export function addedCaller(): void {
  addedAsyncWork()
}
`)

    sandbox.rejects(
      'an unawaited promise on an added line',
      'typescript(no-floating-promises): Promises must be awaited'
    )
  })

  it('fails on a React Doctor finding in a file the change added untracked', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.addFile(
      'added-view.tsx',
      `export function AddedList({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  )
}
`
    )

    sandbox.rejects(
      'an array index used as a React key in a new file',
      'react-doctor(no-array-index-as-key)'
    )
  })
})
