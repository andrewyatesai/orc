import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installBundledSkills } from './bundled-skill-install'
import {
  makeTemporaryDirectory,
  writeGlobalSkillLockFixture,
  writeSkillBundleFixture,
  writeSkillPackageFiles,
  type BundledSkillFixtureSkill
} from './bundled-skill-install.test-fixture'

const NAME = 'offline-demo'
const OLD_FILES = [
  { path: 'SKILL.md', content: '# offline demo v1\n' },
  { path: 'reference/notes.md', content: 'v1 notes\n' }
]
const CURRENT_FILES = [{ path: 'SKILL.md', content: '# offline demo v2\n' }]
const SKILL: BundledSkillFixtureSkill = {
  name: NAME,
  revisions: [
    { releaseRevision: 1, files: OLD_FILES },
    { releaseRevision: 2, files: CURRENT_FILES }
  ]
}

const temporaryDirectories: string[] = []

async function fixture(args: {
  agentHomes: readonly string[]
  skills?: readonly BundledSkillFixtureSkill[]
}): Promise<{ homeDir: string; resourceRoot: string }> {
  const [homeDir, resourceRoot] = await Promise.all([
    makeTemporaryDirectory('orca-skill-install-home-'),
    makeTemporaryDirectory('orca-skill-install-resources-')
  ])
  temporaryDirectories.push(homeDir, resourceRoot)
  for (const agentHome of args.agentHomes) {
    await mkdir(join(homeDir, ...agentHome.split('/')), { recursive: true })
  }
  await writeSkillBundleFixture({ resourceRoot, skills: args.skills ?? [SKILL] })
  return { homeDir, resourceRoot }
}

function packagePath(homeDir: string, agentHome: string): string {
  return join(homeDir, ...agentHome.split('/'), 'skills', NAME)
}

async function skillText(homeDir: string, agentHome: string): Promise<string> {
  return readFile(join(packagePath(homeDir, agentHome), 'SKILL.md'), 'utf8')
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('offline bundled skill install', () => {
  it('installs into every detected agent home and creates none that is absent', async () => {
    const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude', '.codex'] })

    const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

    expect(result).toMatchObject({ name: NAME, outcome: 'installed', reason: null })
    expect(result.placements.map((placement) => [placement.rootId, placement.state])).toEqual([
      ['home-codex', 'installed'],
      ['home-claude', 'installed']
    ])
    expect(await skillText(homeDir, '.claude')).toBe('# offline demo v2\n')
    expect(await skillText(homeDir, '.codex')).toBe('# offline demo v2\n')
    // The install never invents a home for an agent the user does not run.
    expect(await readdir(homeDir)).toEqual(['.claude', '.codex'])
  })

  it('leaves a copy that already matches this build untouched', async () => {
    const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude'] })
    await installBundledSkills({ names: [NAME], homeDir, resourceRoot })
    const skillFile = join(packagePath(homeDir, '.claude'), 'SKILL.md')
    const untouched = new Date(2020, 0, 1)
    await utimes(skillFile, untouched, untouched)

    const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

    expect(result).toMatchObject({ outcome: 'already-current', reason: null })
    expect((await stat(skillFile)).mtime.getFullYear()).toBe(2020)
  })

  it('replaces a copy from an earlier revision, including files it no longer ships', async () => {
    const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude'] })
    await writeSkillPackageFiles(packagePath(homeDir, '.claude'), OLD_FILES)

    const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

    expect(result).toMatchObject({ outcome: 'updated' })
    expect(await readdir(packagePath(homeDir, '.claude'))).toEqual(['SKILL.md'])
    expect(await skillText(homeDir, '.claude')).toBe('# offline demo v2\n')
    expect(await readdir(join(homeDir, '.claude', 'skills'))).toEqual([NAME])
  })

  it('never downgrades a copy from a revision newer than this build', async () => {
    const { homeDir, resourceRoot } = await fixture({
      agentHomes: ['.claude'],
      skills: [{ ...SKILL, currentRevisionIndex: 0 }]
    })
    await writeSkillPackageFiles(packagePath(homeDir, '.claude'), CURRENT_FILES)

    const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

    expect(result).toMatchObject({ outcome: 'already-current' })
    expect(await skillText(homeDir, '.claude')).toBe('# offline demo v2\n')
  })

  it('refuses to overwrite content this build cannot account for', async () => {
    const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude', '.codex'] })
    await writeSkillPackageFiles(packagePath(homeDir, '.claude'), [
      { path: 'SKILL.md', content: '# my own edit\n' }
    ])

    const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

    expect(result.outcome).toBe('refused-user-owned')
    expect(result.placements.map((placement) => [placement.rootId, placement.state])).toEqual([
      ['home-codex', 'installed'],
      ['home-claude', 'refused-unrecognized']
    ])
    expect(await skillText(homeDir, '.claude')).toBe('# my own edit\n')
    expect(await skillText(homeDir, '.codex')).toBe('# offline demo v2\n')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a placement reached through a link out of tree',
    async () => {
      const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude'] })
      const outside = await makeTemporaryDirectory('orca-skill-install-outside-')
      temporaryDirectories.push(outside)
      await writeSkillPackageFiles(outside, OLD_FILES)
      await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true })
      await symlink(outside, packagePath(homeDir, '.claude'))

      const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

      expect(result.outcome).toBe('refused-user-owned')
      expect(result.placements[0]).toMatchObject({
        state: 'refused-unsafe-topology',
        detail: 'external-link'
      })
      expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('# offline demo v1\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a placement it cannot rewrite instead of failing halfway',
    async () => {
      const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude'] })
      const target = packagePath(homeDir, '.claude')
      await writeSkillPackageFiles(target, OLD_FILES)
      await chmod(target, 0o555)
      try {
        const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

        expect(result.outcome).toBe('refused-user-owned')
        expect(result.placements[0]).toMatchObject({ state: 'refused-unsafe-topology' })
        expect(await skillText(homeDir, '.claude')).toBe('# offline demo v1\n')
      } finally {
        await chmod(target, 0o755)
      }
    }
  )

  it('defers a name the npx updater already owns, and installs the rest', async () => {
    const other: BundledSkillFixtureSkill = {
      name: 'offline-other',
      revisions: [{ releaseRevision: 1, files: [{ path: 'SKILL.md', content: '# other\n' }] }]
    }
    const { homeDir, resourceRoot } = await fixture({
      agentHomes: ['.claude'],
      skills: [SKILL, other]
    })
    await writeGlobalSkillLockFixture({ homeDir, skills: { [NAME]: 'a'.repeat(40) } })

    const results = await installBundledSkills({
      names: [NAME, other.name],
      homeDir,
      resourceRoot
    })

    expect(results.map((result) => [result.name, result.outcome])).toEqual([
      [NAME, 'deferred-to-npx'],
      [other.name, 'installed']
    ])
    // Writing under a live lock entry is what makes `skills update` a permanent no-op.
    expect(await readdir(join(homeDir, '.claude', 'skills'))).toEqual([other.name])
  })

  it('installs nothing when the shipped bytes do not match the manifest', async () => {
    const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude'] })
    await writeFile(
      join(resourceRoot, 'skills', 'packages', NAME, 'SKILL.md'),
      '# offline demo v3\n'
    )

    const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

    expect(result).toMatchObject({ outcome: 'bundle-corrupt', placements: [] })
    expect(result.reason).toContain('digest-mismatch')
    expect(await readdir(join(homeDir, '.claude'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'counts a provider alias as the canonical placement it points at',
    async () => {
      const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.agents', '.claude'] })
      await mkdir(join(homeDir, '.agents', 'skills'), { recursive: true })
      await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true })
      await symlink(packagePath(homeDir, '.agents'), packagePath(homeDir, '.claude'))

      const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

      expect(result.outcome).toBe('installed')
      expect(result.placements.map((placement) => [placement.rootId, placement.state])).toEqual([
        ['home-agents', 'installed'],
        ['home-claude', 'alias']
      ])
      expect(await skillText(homeDir, '.claude')).toBe('# offline demo v2\n')
      expect((await stat(join(homeDir, '.agents', 'skills', NAME))).isDirectory()).toBe(true)
    }
  )

  it('answers with an outcome for a name it does not ship, and for an unreadable bundle', async () => {
    const { homeDir, resourceRoot } = await fixture({ agentHomes: ['.claude'] })
    const [unknown] = await installBundledSkills({
      names: ['never-shipped'],
      homeDir,
      resourceRoot
    })
    expect(unknown).toMatchObject({ outcome: 'failed', placements: [] })
    expect(unknown.reason).toContain('unknown-skill')

    const damaged = await makeTemporaryDirectory('orca-skill-install-damaged-')
    temporaryDirectories.push(damaged)
    const results = await installBundledSkills({
      names: [NAME],
      homeDir,
      resourceRoot: damaged
    })
    expect(results).toMatchObject([{ name: NAME, outcome: 'bundle-corrupt', placements: [] }])
    expect(await readdir(join(homeDir, '.claude'))).toEqual([])
  })

  it('reports having nowhere to install rather than creating a home', async () => {
    const { homeDir, resourceRoot } = await fixture({ agentHomes: [] })

    const [result] = await installBundledSkills({ names: [NAME], homeDir, resourceRoot })

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'no-detected-agent-home',
      placements: []
    })
    expect(await readdir(homeDir)).toEqual([])
  })
})
