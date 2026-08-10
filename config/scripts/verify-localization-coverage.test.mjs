// @proves-gate-fires verify:localization-coverage
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'audit-localization-coverage.mjs'
// Exactly what `pnpm run verify:localization-coverage` passes; the flagless arm only reports.
const GATE_ARGS = ['--check']
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const ALLOWLIST_PATH = path.join('config', 'localization-coverage-allowlist.json')
const SEARCH_FILE = 'src/renderer/src/components/workspace-search/WorkspaceSearch.tsx'
const STATUS_FILE = 'src/renderer/src/lib/session-status.ts'

// One reviewed exclusion, so accepting is a real baseline match rather than an empty allowlist.
const BASELINE_PLACEHOLDER = 'Search every workspace'
const BASELINE_ALLOWLIST = [
  {
    filePath: SEARCH_FILE,
    kind: 'jsx-attribute:placeholder',
    text: BASELINE_PLACEHOLDER,
    dynamic: false,
    count: 1
  }
]

const CLEAN_SEARCH_SOURCE = `export function WorkspaceSearch({ t, toast }) {
  return (
    <div className="workspace-search">
      <input placeholder="${BASELINE_PLACEHOLDER}" aria-label={t('search.field')} />
      <button onClick={() => toast.success(t('search.saved'))}>{t('search.save')}</button>
    </div>
  )
}
`
const CLEAN_STATUS_SOURCE = `export function sessionStatusLabel(t, state) {
  return state === 'idle' ? t('session.idle') : t('session.busy')
}
`

const sandboxes = []

/**
 * A miniature repo the gate can audit end to end: its own copy of the script, its own
 * allowlist, and a renderer tree small enough that every candidate is written here.
 */
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-localization-coverage-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), path.join(scriptDir, GATE_SCRIPT))
  // The gate imports typescript-api, so the sandbox needs a resolvable node_modules root.
  await symlink(
    await realpath(path.join(REPO_ROOT, 'node_modules')),
    path.join(root, 'node_modules'),
    'junction'
  )

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_SCRIPT),
    write: async (relativePath, contents) => {
      const target = path.join(root, ...relativePath.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    },
    accepts: () => assertGateAccepts({ script: sandbox.script, args: GATE_ARGS, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, args: GATE_ARGS, cwd: root, violation, expectMessage })
  }

  await sandbox.write(ALLOWLIST_PATH, `${JSON.stringify(BASELINE_ALLOWLIST, null, 2)}\n`)
  await sandbox.write(SEARCH_FILE, CLEAN_SEARCH_SOURCE)
  await sandbox.write(STATUS_FILE, CLEAN_STATUS_SOURCE)
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verify:localization-coverage rejects coverage regressions', () => {
  it('fails when new rendered text ships without going through the catalog', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(
      SEARCH_FILE,
      CLEAN_SEARCH_SOURCE.replace(
        '<div className="workspace-search">',
        '<div className="workspace-search">\n      Recent workspaces'
      )
    )

    sandbox.rejects(
      'rendered text that no locale catalog covers',
      'jsx-text: "Recent workspaces"'
    )
  })

  it('fails when an allowlisted string reappears above its recorded count', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(
      SEARCH_FILE,
      CLEAN_SEARCH_SOURCE.replace(
        '<button',
        `<input placeholder="${BASELINE_PLACEHOLDER}" aria-label={t('search.alternate')} />\n      <button`
      )
    )

    sandbox.rejects(
      'a second uncovered copy of a string the baseline allows once',
      `jsx-attribute:placeholder: "${BASELINE_PLACEHOLDER}"`
    )
  })

  it('fails when a user-visible call raises an uncovered message', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(
      SEARCH_FILE,
      CLEAN_SEARCH_SOURCE.replace("toast.success(t('search.saved'))", "toast.error('Workspace sync failed')")
    )

    sandbox.rejects(
      'a toast message that never reaches the catalog',
      'user-visible-call: "Workspace sync failed"'
    )
  })

  it('names the regression rather than failing silently', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(STATUS_FILE, `${CLEAN_STATUS_SOURCE}export const emptyState = { message: 'No sessions yet' }\n`)

    // The headline banner is emitted for EVERY violation, so asserting only that
    // pins "something was reported", not "THIS was reported" — an audit proved
    // the test still passed against a completely unrelated planted string. The
    // assertion now names the offending file and literal.
    const output = sandbox.rejects(
      'an uncovered message outside the components tree',
      'New unlocalized renderer strings were found.'
    )
    expect(output).toContain(STATUS_FILE)
    expect(output).toContain('No sessions yet')
  })
})
