// @proves-gate-fires check:react-doctor:changed
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_MODULES = ['check-react-doctor-changed.mjs', 'git-pull-request-diff-base.mjs']
const SOURCE_FILE = path.join('src', 'ItemList.jsx')
// react-doctor gates every React rule off unless it detects a React project, and says so
// while still exiting 0 — the fixture declares react so the rules actually run.
const RULES_DISABLED = 'React rules were gated off'
const NOTHING_TO_REPORT = 'No issues found!'
// A cold `pnpm dlx react-doctor@0.9.1` downloads the CLI before it can lint.
const GATE_TIMEOUT_MS = 240_000

const KEYED_ITEM = '<li key={item.id}>{item.name}</li>'
const UNKEYED_ITEM = '<li>{item.name}</li>'
const UNRELATED_EDIT = '<p>{label} has no items yet</p>'

const sandboxes = []

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=orca', '-c', 'user.email=orca@example.test', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

function component(listItem, extra = '') {
  return `import { useState } from 'react'

export function ItemList({ label, items }) {
  const [count, setCount] = useState(0)
  return (
    <div>
      <button type="button" onClick={() => setCount(count + 1)}>
        {label} {count}
      </button>
      ${extra}
      <ul>
        {items.map((item) => (
          ${listItem}
        ))}
      </ul>
    </div>
  )
}
`
}

/**
 * A one-file React repo whose base commit is reachable as `origin/main`, so the gate runs
 * with the exact argv package.json gives it and still resolves a diff base.
 */
async function createSandbox({ committed = KEYED_ITEM } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-react-doctor-gate-'))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, 'src'), { recursive: true })
  await Promise.all(
    GATE_MODULES.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )

  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'react-doctor-changed-gate-fixture',
        version: '0.0.0',
        private: true,
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }
      },
      null,
      2
    )}\n`
  )
  await writeFile(path.join(root, SOURCE_FILE), component(committed))
  git(root, 'init', '--quiet')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_MODULES[0]),
    // The gate diffs the working tree against origin/main, so an uncommitted edit is the input.
    edit: (listItem, extra) => writeFile(path.join(root, SOURCE_FILE), component(listItem, extra)),
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:react-doctor:changed rejects a React error on a changed line', () => {
  it(
    'fails when an edited line renders a list without keys',
    async () => {
      const sandbox = await createSandbox()
      await sandbox.edit(KEYED_ITEM, UNRELATED_EDIT)
      // Positive control: a real edit to real React source that the rules clear.
      const clean = sandbox.accepts()
      expect(clean).not.toContain(RULES_DISABLED)
      expect(clean).toContain(NOTHING_TO_REPORT)

      await sandbox.edit(UNKEYED_ITEM, UNRELATED_EDIT)

      sandbox.rejects('a list item rendered without a key', 'Missing key in list')
    },
    GATE_TIMEOUT_MS
  )

  it(
    'judges the edited lines, not the whole file',
    async () => {
      // Same defect either way; only whether the branch touched its line differs.
      const sandbox = await createSandbox({ committed: UNKEYED_ITEM })
      await sandbox.edit(UNKEYED_ITEM, UNRELATED_EDIT)
      expect(sandbox.accepts()).toContain(NOTHING_TO_REPORT)

      await sandbox.edit(UNKEYED_ITEM.replace('item.name', 'item.name ?? item.id'), UNRELATED_EDIT)

      sandbox.rejects('an edit to the unkeyed list item', 'Missing key in list')
    },
    GATE_TIMEOUT_MS
  )
})
