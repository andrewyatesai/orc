import type { RmOptions } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeTemporaryDirectory,
  skillSnapshotFixture,
  writeSkillPackageFiles
} from './bundled-skill-install.test-fixture'

// Why: the rollback is the guard against losing a package the swap displaced, and
// a rename that fails at exactly that moment cannot be provoked from the outside.
// `persistent` fails the rollback too, which is what process death looks like on disk.
const renameFailure = vi.hoisted(() => ({
  destination: null as string | null,
  persistent: false
}))
// Death after the swap landed but before its scratch was cleaned: also unreachable
// from the outside, and the state only the journal knows how to finish.
const rmFailure = vi.hoisted(() => ({ pattern: null as RegExp | null }))

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: (from: string, to: string) => {
      if (renameFailure.destination !== to) {
        return actual.rename(from, to)
      }
      if (!renameFailure.persistent) {
        renameFailure.destination = null
      }
      return Promise.reject(new Error('rename refused by the test'))
    },
    rm: (path: string, options?: RmOptions) =>
      rmFailure.pattern?.test(path)
        ? Promise.reject(new Error('rm refused by the test'))
        : actual.rm(path, options)
  }
})

import type { SkillBundleArtifacts } from './skill-bundle-artifacts'
import {
  canonicalAgentSkillsRootPath,
  detectBundledSkillInstallRoots
} from './bundled-skill-install-targets'
import {
  classifyBundledSkillTarget,
  type BundledSkillTargetClassification
} from './bundled-skill-target-classification'
import { bundledSkillSwapGuard, writeSkillPackageAtomically } from './bundled-skill-package-write'
import { skillPackageSwapLockPath } from './bundled-skill-swap-lock'
import { recoverInterruptedSkillPackageSwaps } from './bundled-skill-swap-recovery'
import { observeSkillPackage } from './skill-package-identity'

const temporaryDirectories: string[] = []

const NEW_SKILL = [{ path: 'SKILL.md', bytes: Buffer.from('# New\n'), executable: false }]

async function skillsRoot(): Promise<string> {
  const root = await makeTemporaryDirectory('orca-skill-write-')
  temporaryDirectories.push(root)
  return root
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

/** No npx lock entries, which is what makes a refusal below the destination's own doing. */
const noNpxLock = async (): Promise<{
  status: 'absent'
  locks: ReadonlyMap<string, string>
  detail: null
}> => ({ status: 'absent', locks: new Map(), detail: null })

afterEach(async () => {
  renameFailure.destination = null
  renameFailure.persistent = false
  rmFailure.pattern = null
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('atomic skill package write', () => {
  it('writes every file of a multi-file package and leaves no scratch behind', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'skills', 'demo')

    await writeSkillPackageAtomically(packagePath, [
      { path: 'SKILL.md', bytes: Buffer.from('# Demo\n'), executable: false },
      { path: 'reference/notes.md', bytes: Buffer.from('notes\n'), executable: false },
      { path: 'bin/run.sh', bytes: Buffer.from('#!/bin/sh\n'), executable: true }
    ])

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Demo\n')
    expect(await readFile(join(packagePath, 'reference', 'notes.md'), 'utf8')).toBe('notes\n')
    expect(await readdir(join(root, 'skills'))).toEqual(['demo'])
    if (process.platform !== 'win32') {
      expect((await stat(join(packagePath, 'bin', 'run.sh'))).mode & 0o111).not.toBe(0)
      expect((await stat(join(packagePath, 'SKILL.md'))).mode & 0o111).toBe(0)
    }
  })

  it('replaces a package wholesale, dropping files the new revision no longer has', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(join(packagePath, 'reference'), { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    await writeFile(join(packagePath, 'reference', 'gone.md'), 'stale\n')

    await writeSkillPackageAtomically(packagePath, [
      { path: 'SKILL.md', bytes: Buffer.from('# New\n'), executable: false }
    ])

    expect(await readdir(packagePath)).toEqual(['SKILL.md'])
    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# New\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('leaves the previous package untouched when a later file cannot be staged', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')

    await expect(
      writeSkillPackageAtomically(packagePath, [
        { path: 'SKILL.md', bytes: Buffer.from('# New\n'), executable: false },
        // A file cannot also be a directory: staging fails after the first write.
        { path: 'SKILL.md/nested.md', bytes: Buffer.from('nested\n'), executable: false }
      ])
    ).rejects.toThrow()

    expect(await readdir(packagePath)).toEqual(['SKILL.md'])
    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Old\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('restores the displaced package when the swap itself fails', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(join(packagePath, 'reference'), { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    await writeFile(join(packagePath, 'reference', 'notes.md'), 'old notes\n')
    renameFailure.destination = packagePath

    await expect(
      writeSkillPackageAtomically(packagePath, [
        { path: 'SKILL.md', bytes: Buffer.from('# New\n'), executable: false }
      ])
    ).rejects.toThrow('rename refused by the test')

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Old\n')
    expect(await readFile(join(packagePath, 'reference', 'notes.md'), 'utf8')).toBe('old notes\n')
    expect(await readdir(root)).toEqual(['demo'])
  })
})

describe('swap interrupted by process death', () => {
  it('restores the package a killed process left between the two renames', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(join(packagePath, 'reference'), { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    await writeFile(join(packagePath, 'reference', 'notes.md'), 'old notes\n')
    // Failing the rollback rename too leaves exactly what a SIGKILL leaves: the
    // package addressable only under scratch, and no catch block that ever ran.
    renameFailure.destination = packagePath
    renameFailure.persistent = true

    await expect(writeSkillPackageAtomically(packagePath, NEW_SKILL)).rejects.toThrow(
      'skill-package-swap-failed'
    )
    renameFailure.persistent = false
    renameFailure.destination = null
    expect(await exists(packagePath)).toBe(false)
    expect((await readdir(root)).some((entry) => entry.endsWith('.orca-swap.json'))).toBe(true)

    await recoverInterruptedSkillPackageSwaps(root)

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Old\n')
    expect(await readFile(join(packagePath, 'reference', 'notes.md'), 'utf8')).toBe('old notes\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('restores a displaced copy stranded with no journal to read', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    // What a build without the journal left behind, and what the sweep preserves forever.
    await rename(packagePath, join(root, '.demo.orca-replaced-0123456789ab'))

    await recoverInterruptedSkillPackageSwaps(root)

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Old\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('discards the copy a completed swap displaced, which no sweep would reclaim yet', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    // The scratch survives the swap that succeeded, exactly as a kill would leave it.
    rmFailure.pattern = /\.orca-(replaced-[0-9a-f]+|swap\.json)$/

    await writeSkillPackageAtomically(packagePath, NEW_SKILL)
    rmFailure.pattern = null
    expect((await readdir(root)).some((entry) => entry.includes('.orca-replaced-'))).toBe(true)

    await recoverInterruptedSkillPackageSwaps(root)

    // Fresh scratch is far too young for the age-based sweep; only the journal
    // knows the swap it belonged to is finished.
    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# New\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('leaves a package alone when the swap that journalled it completed', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')

    await writeSkillPackageAtomically(packagePath, NEW_SKILL)
    await recoverInterruptedSkillPackageSwaps(root)

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# New\n')
    expect(await readdir(root)).toEqual(['demo'])
  })
})

describe('refusing a destination that changed after it was classified', () => {
  async function classifierFor(
    packagePath: string
  ): Promise<() => Promise<BundledSkillTargetClassification>> {
    const authorised = (await observeSkillPackage(packagePath)).observedDigest
    return async () => ({
      state:
        (await observeSkillPackage(packagePath)).observedDigest === authorised
          ? 'ours-older'
          : 'unrecognized',
      resolvedPath: packagePath,
      detail: null
    })
  }

  it('refuses when the user edits the package between classification and the rename', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# ours v1\n')
    const reclassify = await classifierFor(packagePath)
    const guard = bundledSkillSwapGuard({
      name: 'demo',
      expected: await reclassify(),
      reclassify,
      relock: noNpxLock
    })

    await expect(
      writeSkillPackageAtomically(packagePath, NEW_SKILL, {
        // The window classification cannot see: staged, one rename from displacement.
        revalidate: async () => {
          await writeFile(join(packagePath, 'SKILL.md'), '# my own edit\n')
          return guard()
        }
      })
    ).rejects.toThrow('destination-changed: unrecognized')

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# my own edit\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('refuses when npx registers the name between classification and the rename', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# ours v1\n')
    const reclassify = await classifierFor(packagePath)
    let npxOwnsIt = false
    const guard = bundledSkillSwapGuard({
      name: 'demo',
      expected: await reclassify(),
      reclassify,
      relock: async () =>
        npxOwnsIt
          ? {
              status: 'readable',
              locks: new Map([['demo', 'a'.repeat(40)]]),
              detail: null
            }
          : noNpxLock()
    })

    await expect(
      writeSkillPackageAtomically(packagePath, NEW_SKILL, {
        revalidate: async () => {
          npxOwnsIt = true
          return guard()
        }
      })
    ).rejects.toThrow('npx-lock-now-owns: demo')

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# ours v1\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('refuses when the destination directory is replaced outright, with no caller guard', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# ours v1\n')

    await expect(
      writeSkillPackageAtomically(packagePath, NEW_SKILL, {
        revalidate: async () => {
          // Another writer puts a different directory under the same name.
          await rm(packagePath, { recursive: true, force: true })
          await mkdir(join(packagePath, 'theirs'), { recursive: true })
          await writeFile(join(packagePath, 'SKILL.md'), '# someone else\n')
          return null
        }
      })
    ).rejects.toThrow('destination-identity-changed')

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# someone else\n')
    expect(await readdir(root)).toEqual(['demo'])
  })
})

describe('a first install, whose own mkdir creates the skills root', () => {
  const SKILL_NAME = 'demo'
  const OURS = [{ path: 'SKILL.md', content: '# New\n' }]

  /** A `/var -> /private/var` shaped link above a home whose skills root is absent. */
  async function firstInstallClassifyArgs(): Promise<
    Parameters<typeof classifyBundledSkillTarget>[0]
  > {
    const base = await skillsRoot()
    await mkdir(join(base, 'physical', 'home', '.claude'), { recursive: true })
    await symlink(join(base, 'physical'), join(base, 'linked'))
    const homeDir = join(base, 'linked', 'home')
    const [root] = await detectBundledSkillInstallRoots({ homeDir })
    const snapshot = skillSnapshotFixture(OURS, 1)
    const entry = { name: SKILL_NAME, sourcePath: `skills/${SKILL_NAME}`, ...snapshot }
    const artifacts: SkillBundleArtifacts = {
      manifest: { schemaVersion: 2, skills: [entry] },
      registry: { schemaVersion: 1, skills: { [SKILL_NAME]: [snapshot] } },
      releaseMapping: { schemaVersion: 1, releases: [] },
      knownSnapshots: { [SKILL_NAME]: [snapshot] },
      releasedAppVersions: {}
    }
    return { root, entry, artifacts, canonicalRootPath: canonicalAgentSkillsRootPath(homeDir) }
  }

  async function guardedWrite(
    classifyArgs: Parameters<typeof classifyBundledSkillTarget>[0],
    takeover?: (packagePath: string) => Promise<void>
  ): Promise<string> {
    const expected = await classifyBundledSkillTarget(classifyArgs)
    expect(expected.state).toBe('absent')
    const packagePath = expected.resolvedPath ?? classifyArgs.root.path
    const guard = bundledSkillSwapGuard({
      name: SKILL_NAME,
      expected,
      reclassify: () => classifyBundledSkillTarget(classifyArgs),
      relock: noNpxLock
    })
    await writeSkillPackageAtomically(packagePath, NEW_SKILL, {
      revalidate: async () => {
        await takeover?.(packagePath)
        return guard()
      }
    })
    return packagePath
  }

  it.skipIf(process.platform === 'win32')(
    'writes rather than reading the root it just created as someone else claiming it',
    async () => {
      const packagePath = await guardedWrite(await firstInstallClassifyArgs())

      expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# New\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still refuses when someone else fills the destination while ours is staged',
    async () => {
      const classifyArgs = await firstInstallClassifyArgs()

      await expect(
        guardedWrite(classifyArgs, (packagePath) =>
          writeSkillPackageFiles(packagePath, [{ path: 'SKILL.md', content: '# someone else\n' }])
        )
      ).rejects.toThrow('destination-changed: unrecognized')

      const packagePath = join(classifyArgs.root.path, SKILL_NAME)
      expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# someone else\n')
    }
  )
})

describe('cross-process swap lock', () => {
  it('waits for the lock another process holds instead of displacing under it', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    const lockPath = skillPackageSwapLockPath(packagePath)
    // A live owner on this host: not stale, not reclaimable.
    await writeFile(
      lockPath,
      JSON.stringify({
        token: 'another-process',
        pid: process.pid,
        host: hostname(),
        at: Date.now()
      })
    )

    const write = writeSkillPackageAtomically(packagePath, NEW_SKILL)
    await delay(150)
    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Old\n')

    await rm(lockPath, { force: true })
    await write

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# New\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('reclaims a lock whose owner died and completes the swap', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    await writeFile(
      skillPackageSwapLockPath(packagePath),
      JSON.stringify({
        token: 'dead-process',
        pid: process.pid,
        host: hostname(),
        at: Date.now() - 60 * 60 * 1000
      })
    )

    await writeSkillPackageAtomically(packagePath, NEW_SKILL)

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# New\n')
    expect(await readdir(root)).toEqual(['demo'])
  })
})
