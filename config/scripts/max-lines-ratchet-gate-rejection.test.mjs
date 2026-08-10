// @proves-gate-fires check:max-lines-ratchet
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'check-max-lines-ratchet.mjs'
const BASELINE_PATH = path.join('config', 'max-lines-baseline.txt')
const MOBILE_CONFIG_PATH = path.join('mobile', '.oxlintrc.json')
const LEGACY_ENTRY = 'inline src/renderer/legacy-panel.ts'
const LEGACY_GLOB = 'app/legacy/*.tsx'
// The ratchet keys a mobile entry on glob AND budget, so the baseline carries both.
const LEGACY_MAX = 1200
// Assembled at runtime: the shipped ratchet scans this file too, and a line spelling
// the whole directive would register as a real bypass of the rule under test.
const RULE = 'max-lines'
const SUPPRESSION = `/* oxlint-disable ${RULE} */`

const sandboxes = []

function git(cwd, ...args) {
  return execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=orca',
      '-c',
      'user.email=orca@example.test',
      '-c',
      'init.defaultBranch=main',
      ...args
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

// `src/strict-panel.tsx` caps BELOW the .tsx default: stricter is not a bypass, so a
// gate that flagged it would fail the positive control instead of scoring free rejections.
function mobileConfig(extraOverrides = []) {
  const overrides = [
    { files: [LEGACY_GLOB], rules: { [RULE]: ['error', { max: LEGACY_MAX }] } },
    { files: ['src/strict-panel.tsx'], rules: { [RULE]: ['error', { max: 200 }] } },
    ...extraOverrides
  ]
  return `${JSON.stringify({ overrides }, null, 2)}\n`
}

// A whole fake repo: tracked sources, a mobile oxlint config, and a baseline that
// already matches them, so the gate's own copy passes before anything is planted.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-max-lines-ratchet-gate-')))
  sandboxes.push(root)
  await mkdir(path.join(root, 'config', 'scripts'), { recursive: true })
  await mkdir(path.join(root, 'src', 'renderer'), { recursive: true })
  await mkdir(path.join(root, 'mobile'), { recursive: true })
  await copyFile(
    path.join(import.meta.dirname, GATE_SCRIPT),
    path.join(root, 'config', 'scripts', GATE_SCRIPT)
  )

  const legacy = path.join(root, 'src', 'renderer', 'legacy-panel.ts')
  const feature = path.join(root, 'src', 'renderer', 'new-feature.ts')
  await writeFile(legacy, `${SUPPRESSION}\nexport const legacy = 1\n`)
  await writeFile(feature, 'export const feature = 1\n')
  await writeFile(path.join(root, MOBILE_CONFIG_PATH), mobileConfig())
  await writeFile(
    path.join(root, BASELINE_PATH),
    `# fixture baseline\n${LEGACY_ENTRY}\nmobile-config ${LEGACY_GLOB} max=${LEGACY_MAX}\n`
  )

  git(root, 'init', '--quiet')
  // The gate enumerates candidates with `git ls-files`, so only tracked sources count.
  git(root, 'add', 'src')
  git(root, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture')

  const script = path.join(root, 'config', 'scripts', GATE_SCRIPT)
  return {
    root,
    // Run it the way package.json does: `node config/scripts/check-max-lines-ratchet.mjs`, no flags.
    accepts: () => assertGateAccepts({ script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script, cwd: root, violation, expectMessage }),
    plantInlineSuppression: async () =>
      writeFile(feature, `${SUPPRESSION}\n${await readFile(feature, 'utf8')}`),
    plantMobileBump: (glob) =>
      writeFile(
        path.join(root, MOBILE_CONFIG_PATH),
        mobileConfig([{ files: [glob], rules: { [RULE]: ['error', { max: 5000 }] } }])
      ),
    plantStricterMobileOverride: (glob) =>
      writeFile(
        path.join(root, MOBILE_CONFIG_PATH),
        mobileConfig([{ files: [glob], rules: { [RULE]: ['error', { max: 100 }] } }])
      ),
    plantDroppedSuppression: () => writeFile(legacy, 'export const legacy = 1\n'),
    plantMovedSuppression: async () => {
      await writeFile(legacy, 'export const legacy = 1\n')
      await writeFile(feature, `${SUPPRESSION}\nexport const feature = 1\n`)
    }
  }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:max-lines-ratchet rejects the new bypasses it exists to block', () => {
  it('fails when a tracked file gains a suppression that is not in the baseline', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plantInlineSuppression()

    sandbox.rejects(
      'a new inline max-lines suppression',
      '::error::New max-lines bypass not allowed: inline src/renderer/new-feature.ts'
    )
  })

  it('fails when mobile/.oxlintrc.json gains a per-file bump above the default budget', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plantMobileBump('app/settings/*.tsx')

    sandbox.rejects(
      'a new mobile per-file max-lines bump',
      '::error::New max-lines bypass not allowed: mobile-config app/settings/*.tsx max=5000'
    )
  })

  it('fails when a baseline entry outlives its suppression, so the list can only shrink', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plantDroppedSuppression()

    sandbox.rejects(
      'a baseline entry whose suppression is gone',
      `::error::Stale max-lines baseline entry (prune it): ${LEGACY_ENTRY}`
    )
  })

  it('fails when a suppression moves to another file, matching identity not count', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plantMovedSuppression()

    sandbox.rejects(
      'a suppression relocated to a file outside the baseline',
      '::error::New max-lines bypass not allowed: inline src/renderer/new-feature.ts'
    )
  })

  it('still passes when a new mobile override is stricter than the default budget', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plantStricterMobileOverride('app/tiny/*.tsx')

    // Not a plant the gate should catch: a lower `max` tightens the rule. Rejecting it
    // would mean the arms above pass on a gate that is simply red for any edit.
    sandbox.accepts()
  })
})
