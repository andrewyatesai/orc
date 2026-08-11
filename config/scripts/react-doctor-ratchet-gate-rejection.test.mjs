// @proves-gate-fires lint:react-doctor
//
// (This file originally carried a comment saying the coverage ledger enumerates
// only `check:`/`verify:` scripts, so it could not be tagged. That stopped being
// true when the ledger's scope widened to `lint:` — leaving the tag off would have
// made this the one gate matching `^(check|verify|lint):` that is neither covered
// nor listed as debt, so if lint-react-doctor.mjs ever went inert nothing would
// notice.)
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
// The shipped entry point, run against a fixture root — package.json runs this exact file.
const GATE_SCRIPT = path.join(REPO_ROOT, 'config', 'scripts', 'lint-react-doctor.mjs')
const CONFIG_PATH = path.join('config', 'oxlint-react-doctor.json')
const BASELINE_PATH = path.join('config', 'react-doctor-baseline.txt')
const LEGACY_FILE = 'src/LegacyList.jsx'
const CLEAN_FILE = 'src/CleanList.jsx'
const RULE = 'no-array-index-as-key'
const OK = 'react-doctor ratchet OK'
const GATE_TIMEOUT_MS = 60_000

const sandboxes = []

function list(name, key) {
  return `export function ${name}({ items }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={${key}}>{item}</li>
      ))}
    </ul>
  )
}
`
}

/**
 * A fixture root with its own config + baseline. Only the plugin specifier differs from
 * the shipped config: pnpm's node_modules lives at the repo, not in a tmpdir sandbox, so
 * the bare package name would not resolve from here.
 */
async function createSandbox() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-react-doctor-ratchet-'))
  sandboxes.push(root)
  await mkdir(path.join(root, 'config'), { recursive: true })
  await mkdir(path.join(root, 'src'), { recursive: true })

  const config = JSON.parse(await readFile(path.join(REPO_ROOT, CONFIG_PATH), 'utf8'))
  config.jsPlugins = [
    {
      name: 'react-doctor',
      specifier: createRequire(import.meta.url).resolve('oxlint-plugin-react-doctor')
    }
  ]
  await writeFile(path.join(root, CONFIG_PATH), `${JSON.stringify(config, null, 2)}\n`)
  // One tolerated finding and one clean file, so a gate that reported nothing would fail
  // the positive control instead of scoring free rejections.
  await writeFile(path.join(root, LEGACY_FILE), list('LegacyList', 'index'))
  await writeFile(path.join(root, CLEAN_FILE), list('CleanList', 'item.id'))
  await writeFile(path.join(root, BASELINE_PATH), `# fixture\n${LEGACY_FILE} ${RULE} 1\n`)

  const sandbox = {
    root,
    accepts: () => assertGateAccepts({ script: GATE_SCRIPT, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: GATE_SCRIPT, cwd: root, violation, expectMessage }),
    write: (file, contents) => writeFile(path.join(root, file), contents),
    rewriteConfig: async (mutate) => {
      const current = JSON.parse(await readFile(path.join(root, CONFIG_PATH), 'utf8'))
      mutate(current)
      await writeFile(path.join(root, CONFIG_PATH), `${JSON.stringify(current, null, 2)}\n`)
    }
  }
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('lint:react-doctor rejects the findings the ratchet exists to block', () => {
  it(
    'passes only while every finding is one the baseline already recorded',
    async () => {
      const sandbox = await createSandbox()
      // Positive control: real rules, real findings, and the count still matches.
      expect(sandbox.accepts()).toContain(`${OK} — 1 grandfathered finding(s)`)
    },
    GATE_TIMEOUT_MS
  )

  it(
    'fails when an unlisted file reports a finding',
    async () => {
      const sandbox = await createSandbox()
      sandbox.accepts()

      await sandbox.write(CLEAN_FILE, list('CleanList', 'index'))

      sandbox.rejects(
        'an array index used as a key in a file the baseline does not list',
        `::error::New react-doctor finding: ${CLEAN_FILE} ${RULE} (baseline 0, now 1)`
      )
    },
    GATE_TIMEOUT_MS
  )

  it(
    'fails when a baselined file gains one more finding of the same rule',
    async () => {
      // The count is the budget, not just the file: a file already on the list may not
      // keep collecting findings under its entry.
      const sandbox = await createSandbox()
      sandbox.accepts()

      await sandbox.write(
        LEGACY_FILE,
        `${list('LegacyList', 'index')}${list('SecondList', 'index')}`
      )

      sandbox.rejects(
        'a second array-index key inside an already-baselined file',
        `::error::New react-doctor finding: ${LEGACY_FILE} ${RULE} (baseline 1, now 2)`
      )
    },
    GATE_TIMEOUT_MS
  )

  it(
    'fails when a baseline entry outlives its finding, so the list can only shrink',
    async () => {
      const sandbox = await createSandbox()
      sandbox.accepts()

      await sandbox.write(LEGACY_FILE, list('LegacyList', 'item.id'))

      sandbox.rejects(
        'a fixed finding whose baseline entry still reserves room for it',
        `::error::Stale react-doctor baseline entry (prune it): ${LEGACY_FILE} ${RULE}`
      )
    },
    GATE_TIMEOUT_MS
  )

  it(
    'fails instead of passing when the react-doctor rules never ran',
    async () => {
      // The failure mode this gate is most likely to die of: findings stop appearing
      // because the plugin stopped loading, and an unguarded ratchet calls that green.
      const sandbox = await createSandbox()
      sandbox.accepts()

      await sandbox.rewriteConfig((config) => {
        config.jsPlugins = []
      })

      sandbox.rejects(
        'a config whose react-doctor plugin is gone',
        "Plugin 'react-doctor' not found"
      )
    },
    GATE_TIMEOUT_MS
  )
})
