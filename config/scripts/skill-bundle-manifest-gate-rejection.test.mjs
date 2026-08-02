// @proves-gate-fires verify:skill-bundle-manifest
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GENERATOR_MODULES = [
  'generate-skill-bundle-manifest.mjs',
  'skill-release-history-stability.mjs',
  'skill-package-payload.mjs'
]
const STALE = 'Generated skill artifacts are stale'
const sandboxes = []

// The generator resolves its repo root from its own location, so a copy of the real
// script in a throwaway tree runs the shipped gate rather than a re-implementation.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-skill-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await Promise.all(
    GENERATOR_MODULES.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )
  await addSkill(root, 'demo', 'demo skill\n')
  const script = path.join(scriptDir, GENERATOR_MODULES[0])
  return {
    root,
    script,
    write: () => assertGateAccepts({ script, args: ['--write'], cwd: root }),
    accepts: () => assertGateAccepts({ script, cwd: root }),
    rejects: (violation) =>
      assertGateRejects({ script, cwd: root, violation, expectMessage: STALE })
  }
}

async function addSkill(root, name, body) {
  await mkdir(path.join(root, 'skills', name), { recursive: true })
  await writeFile(path.join(root, 'skills', name, 'SKILL.md'), body)
}

function artifact(root, ...segments) {
  return path.join(root, 'resources', 'skills', ...segments)
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verify:skill-bundle-manifest rejects drift it is supposed to catch', () => {
  it('fails when the shipped payload no longer matches the manifest', async () => {
    const sandbox = await createSandbox()
    sandbox.write()
    sandbox.accepts()

    await writeFile(artifact(sandbox.root, 'packages', 'demo', 'SKILL.md'), 'tampered\n')

    expect(sandbox.rejects('an edited payload file')).toContain(
      path.join('resources', 'skills', 'packages', 'demo', 'SKILL.md')
    )
  })

  it('fails when a skill ships bytes no manifest entry describes', async () => {
    const sandbox = await createSandbox()
    sandbox.write()

    await writeFile(artifact(sandbox.root, 'packages', 'demo', 'ORPHAN.md'), 'unshipped\n')

    sandbox.rejects('an orphan payload file')
  })

  it('fails when a new skill is added without regenerating', async () => {
    const sandbox = await createSandbox()
    sandbox.write()

    await addSkill(sandbox.root, 'second', 'a skill nobody regenerated for\n')

    sandbox.rejects('an unregenerated skill directory')
  })

  it('fails when the committed manifest is edited by hand', async () => {
    const sandbox = await createSandbox()
    sandbox.write()
    const manifestPath = artifact(sandbox.root, 'current-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.skills[0].packageDigest = 'f'.repeat(64)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(sandbox.rejects('a hand-edited manifest digest')).toContain('current-manifest.json')
  })
})
