import { mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSkillBundleArtifacts } from './skill-bundle-artifacts'
import { readBundledSkillPayload } from './bundled-skill-payload'
import {
  makeTemporaryDirectory,
  writeSkillBundleFixture
} from './bundled-skill-install.test-fixture'

const temporaryDirectories: string[] = []

const SKILL = {
  name: 'offline-fixture',
  revisions: [
    {
      releaseRevision: 1,
      files: [
        { path: 'SKILL.md', content: '# Offline fixture\n' },
        { path: 'reference/notes.md', content: 'notes\n' }
      ]
    }
  ]
}

async function fixtureResourceRoot(): Promise<string> {
  const resourceRoot = await makeTemporaryDirectory('orca-skill-payload-')
  temporaryDirectories.push(resourceRoot)
  await writeSkillBundleFixture({ resourceRoot, skills: [SKILL] })
  return resourceRoot
}

function packageRoot(resourceRoot: string): string {
  return join(resourceRoot, 'skills', 'packages', SKILL.name)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('bundled skill payload', () => {
  it('verifies the payload this build actually ships', async () => {
    const resourceRoot = resolve('resources')
    const artifacts = await loadSkillBundleArtifacts(resourceRoot)
    for (const entry of artifacts.manifest.skills) {
      const payload = await readBundledSkillPayload({ name: entry.name, artifacts, resourceRoot })
      expect(payload.verified, `${entry.name}: ${JSON.stringify(payload)}`).toBe(true)
      if (payload.verified) {
        expect(payload.files.map((file) => file.path)).toEqual(entry.files.map((file) => file.path))
      }
    }
  })

  it('reads every manifest file with its declared mode', async () => {
    const resourceRoot = await fixtureResourceRoot()
    const payload = await readBundledSkillPayload({
      name: SKILL.name,
      artifacts: await loadSkillBundleArtifacts(resourceRoot),
      resourceRoot
    })
    expect(payload.verified).toBe(true)
    if (payload.verified) {
      expect(payload.files).toEqual([
        { path: 'SKILL.md', bytes: Buffer.from('# Offline fixture\n'), executable: false },
        { path: 'reference/notes.md', bytes: Buffer.from('notes\n'), executable: false }
      ])
    }
  })

  it('fails closed on tampered bytes rather than installing them', async () => {
    const resourceRoot = await fixtureResourceRoot()
    const artifacts = await loadSkillBundleArtifacts(resourceRoot)
    // Same length, different content: only the digest can catch this.
    await writeFile(join(packageRoot(resourceRoot), 'SKILL.md'), '# 0ffline fixture\n')

    expect(await readBundledSkillPayload({ name: SKILL.name, artifacts, resourceRoot })).toEqual({
      verified: false,
      failure: 'digest-mismatch',
      detail: 'SKILL.md'
    })
  })

  it('fails closed on a truncated, missing, or unexpected file', async () => {
    const truncated = await fixtureResourceRoot()
    await truncate(join(packageRoot(truncated), 'SKILL.md'), 3)
    expect(
      await readBundledSkillPayload({
        name: SKILL.name,
        artifacts: await loadSkillBundleArtifacts(truncated),
        resourceRoot: truncated
      })
    ).toMatchObject({ verified: false, failure: 'size-mismatch' })

    const missing = await fixtureResourceRoot()
    await rm(join(packageRoot(missing), 'reference'), { recursive: true })
    expect(
      await readBundledSkillPayload({
        name: SKILL.name,
        artifacts: await loadSkillBundleArtifacts(missing),
        resourceRoot: missing
      })
    ).toMatchObject({ verified: false, failure: 'file-missing', detail: 'reference/notes.md' })

    const extra = await fixtureResourceRoot()
    await writeFile(join(packageRoot(extra), 'unlisted.md'), 'surprise\n')
    expect(
      await readBundledSkillPayload({
        name: SKILL.name,
        artifacts: await loadSkillBundleArtifacts(extra),
        resourceRoot: extra
      })
    ).toMatchObject({ verified: false, failure: 'extra-file', detail: 'unlisted.md' })
  })

  it('reports a missing package directory instead of throwing', async () => {
    const resourceRoot = await fixtureResourceRoot()
    const artifacts = await loadSkillBundleArtifacts(resourceRoot)
    await rm(packageRoot(resourceRoot), { recursive: true })

    expect(
      await readBundledSkillPayload({ name: SKILL.name, artifacts, resourceRoot })
    ).toMatchObject({ verified: false, failure: 'file-missing' })
  })

  it('refuses a name the manifest does not describe', async () => {
    const resourceRoot = await fixtureResourceRoot()
    expect(
      await readBundledSkillPayload({
        name: 'not-shipped',
        artifacts: await loadSkillBundleArtifacts(resourceRoot),
        resourceRoot
      })
    ).toEqual({ verified: false, failure: 'unknown-skill', detail: 'not-shipped' })
  })

  it.skipIf(process.platform === 'win32')(
    'never follows a link planted in the payload',
    async () => {
      const resourceRoot = await fixtureResourceRoot()
      const artifacts = await loadSkillBundleArtifacts(resourceRoot)
      const outside = await makeTemporaryDirectory('orca-skill-payload-outside-')
      temporaryDirectories.push(outside)
      await mkdir(join(outside, 'elsewhere'), { recursive: true })
      await writeFile(join(outside, 'elsewhere', 'SKILL.md'), '# Offline fixture\n')
      await rm(join(packageRoot(resourceRoot), 'reference'), { recursive: true })
      await symlink(join(outside, 'elsewhere'), join(packageRoot(resourceRoot), 'reference'))

      expect(
        await readBundledSkillPayload({ name: SKILL.name, artifacts, resourceRoot })
      ).toMatchObject({ verified: false, failure: 'extra-file' })
    }
  )
})
