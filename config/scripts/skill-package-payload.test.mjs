import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPackageFiles } from './generate-skill-bundle-manifest.mjs'
import { verifySkillPackagePayload, writeSkillPackagePayload } from './skill-package-payload.mjs'

const temporaryDirectories = []

async function createRepo(packages) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-skill-payload-'))
  temporaryDirectories.push(root)
  const skillsRoot = path.join(root, 'skills')
  for (const [relativePath, body] of Object.entries(packages)) {
    const filePath = path.join(skillsRoot, ...relativePath.split('/'))
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, body)
  }
  return { root, skillsRoot, packagesRoot: path.join(root, 'resources', 'skills', 'packages') }
}

// Why: building the manifest through the generator's own walk keeps the fixture
// honest — a hand-written size or hash would test the fixture, not the payload.
async function manifestFor(skillsRoot) {
  const names = (await readdir(skillsRoot)).sort()
  const skills = []
  for (const name of names) {
    const files = await collectPackageFiles(path.join(skillsRoot, name))
    skills.push({ name, files: files.map(({ gitBlobSha: _gitBlobSha, ...file }) => file) })
  }
  return { schemaVersion: 2, skills }
}

async function emit(repo) {
  const manifest = await manifestFor(repo.skillsRoot)
  await writeSkillPackagePayload({ ...repo, manifest })
  return manifest
}

async function payloadPaths(packagesRoot) {
  const found = []
  for (const entry of await readdir(packagesRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      found.push(path.relative(packagesRoot, path.join(entry.parentPath, entry.name)))
    }
  }
  return found.sort()
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill package payload', () => {
  it('emits every manifest file byte-for-byte and verifies clean', async () => {
    const repo = await createRepo({
      'orca-cli/SKILL.md': 'cli stub\n',
      'orchestration/SKILL.md': 'orchestration stub\r\nsecond line\r\n'
    })

    const manifest = await emit(repo)

    expect(await payloadPaths(repo.packagesRoot)).toEqual([
      path.join('orca-cli', 'SKILL.md'),
      path.join('orchestration', 'SKILL.md')
    ])
    // CRLF bytes survive: exactSha256 addresses bytes, not normalized text.
    expect(await readFile(path.join(repo.packagesRoot, 'orchestration', 'SKILL.md'), 'utf8')).toBe(
      'orchestration stub\r\nsecond line\r\n'
    )
    await expect(
      verifySkillPackagePayload({ ...repo, manifest, repoRoot: repo.root })
    ).resolves.toBeUndefined()
  })

  it('round-trips nested subdirectory paths', async () => {
    const repo = await createRepo({
      'orca-cli/SKILL.md': 'cli stub\n',
      'orca-cli/references/deep/notes.md': 'nested reference\n'
    })

    const manifest = await emit(repo)

    expect(await payloadPaths(repo.packagesRoot)).toEqual([
      path.join('orca-cli', 'SKILL.md'),
      path.join('orca-cli', 'references', 'deep', 'notes.md')
    ])
    await expect(verifySkillPackagePayload({ ...repo, manifest })).resolves.toBeUndefined()
  })

  it('reports an edited payload byte as stale, with the shared remedy', async () => {
    const repo = await createRepo({ 'orca-cli/SKILL.md': 'cli stub\n' })
    const manifest = await emit(repo)

    await writeFile(path.join(repo.packagesRoot, 'orca-cli', 'SKILL.md'), 'cli stub tampered\n')

    await expect(verifySkillPackagePayload({ ...repo, manifest, repoRoot: repo.root })).rejects
      .toThrow(`Generated skill artifacts are stale:
${path.join('resources', 'skills', 'packages', 'orca-cli', 'SKILL.md')}
Run pnpm generate:skill-bundle-manifest.`)
  })

  it('reports a same-size edit as stale', async () => {
    const repo = await createRepo({ 'orca-cli/SKILL.md': 'cli stub\n' })
    const manifest = await emit(repo)

    await writeFile(path.join(repo.packagesRoot, 'orca-cli', 'SKILL.md'), 'CLI STUB\n')

    await expect(verifySkillPackagePayload({ ...repo, manifest })).rejects.toThrow(
      /Generated skill artifacts are stale/
    )
  })

  it('reports a missing payload file and a never-generated payload root as stale', async () => {
    const repo = await createRepo({ 'orca-cli/SKILL.md': 'cli stub\n' })
    const manifest = await emit(repo)

    await rm(path.join(repo.packagesRoot, 'orca-cli', 'SKILL.md'))
    await expect(verifySkillPackagePayload({ ...repo, manifest })).rejects.toThrow(
      /Generated skill artifacts are stale/
    )

    // A payload that was never emitted is every file stale, not an ENOENT crash.
    await rm(repo.packagesRoot, { recursive: true })
    await expect(verifySkillPackagePayload({ ...repo, manifest })).rejects.toThrow(
      /Generated skill artifacts are stale/
    )
  })

  it('reports an orphan payload file as stale', async () => {
    const repo = await createRepo({ 'orca-cli/SKILL.md': 'cli stub\n' })
    const manifest = await emit(repo)

    await writeFile(path.join(repo.packagesRoot, 'orca-cli', 'stray.md'), 'no manifest entry\n')

    await expect(verifySkillPackagePayload({ ...repo, manifest, repoRoot: repo.root })).rejects
      .toThrow(`Generated skill artifacts are stale:
${path.join('resources', 'skills', 'packages', 'orca-cli', 'stray.md')}
Run pnpm generate:skill-bundle-manifest.`)
  })

  it('prunes a removed skill on the next emission', async () => {
    const repo = await createRepo({
      'orca-cli/SKILL.md': 'cli stub\n',
      'retired/SKILL.md': 'retired stub\n'
    })
    await emit(repo)

    await rm(path.join(repo.skillsRoot, 'retired'), { recursive: true })
    const manifest = await emit(repo)

    expect(await payloadPaths(repo.packagesRoot)).toEqual([path.join('orca-cli', 'SKILL.md')])
    await expect(verifySkillPackagePayload({ ...repo, manifest })).resolves.toBeUndefined()
  })

  it('refuses to emit bytes the manifest does not describe', async () => {
    const repo = await createRepo({ 'orca-cli/SKILL.md': 'cli stub\n' })
    const manifest = await manifestFor(repo.skillsRoot)

    // The generator hashes before this copy runs; an edit in between must fail loudly.
    await writeFile(path.join(repo.skillsRoot, 'orca-cli', 'SKILL.md'), 'edited mid-run\n')

    await expect(writeSkillPackagePayload({ ...repo, manifest })).rejects.toThrow(
      `Skill bytes changed while emitting the payload: ${path.join('orca-cli', 'SKILL.md')}`
    )
  })
})
