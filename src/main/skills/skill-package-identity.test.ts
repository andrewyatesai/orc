import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeObservedSkillFile,
  matchingKnownSnapshot,
  observeSkillPackage,
  officialPathsGitTreeSha,
  skillPackageDigest
} from './skill-package-identity'

const temporaryDirectories: string[] = []

async function temporarySkill(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-freshness-'))
  temporaryDirectories.push(root)
  return root
}

/** A byte-identical folder elsewhere, so a hash can be derived without the original. */
async function copyOf(source: string): Promise<string> {
  const target = await temporarySkill()
  await cp(source, target, { recursive: true })
  return target
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('skill package identity', () => {
  it('matches CRLF installed text to an LF official snapshot', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'first\r\nsecond\r\n')
    const observed = await observeSkillPackage(root)
    const expected = describeObservedSkillFile('SKILL.md', Buffer.from('first\nsecond\n'), false)

    // Why: scans can observe several package byte budgets concurrently; only
    // hashes, not raw file buffers, should survive each file's identity pass.
    expect(observed.files[0]).not.toHaveProperty('bytes')
    expect(
      matchingKnownSnapshot(
        observed,
        [
          {
            releaseRevision: 1,
            packageDigest: skillPackageDigest([expected]),
            gitTreeSha: 'tree',
            files: [expected]
          }
        ],
        new Set(['SKILL.md'])
      )?.releaseRevision
    ).toBe(1)
  })

  it('tolerates an agent-CLI sidecar beside untouched official bytes, drift stays closed', async () => {
    // Agent CLIs write agents/openai.yaml (and similar) without editing official bytes;
    // an unlisted neighbour must not mark the package unrecognized. Content drift on a
    // listed file remains fail-closed.
    const official = await temporarySkill()
    await writeFile(join(official, 'SKILL.md'), 'skill\n')
    const snapshot = [
      {
        releaseRevision: 1,
        packageDigest: (await observeSkillPackage(official)).observedDigest,
        gitTreeSha: (await observeSkillPackage(official)).observedGitTreeSha,
        files: (await observeSkillPackage(official)).files
      }
    ]

    const edited = await temporarySkill()
    await writeFile(join(edited, 'SKILL.md'), 'skill\nlocal tweak\n')
    await writeFile(join(edited, '.DS_Store'), Buffer.from([0, 1]))

    const withSidecar = await temporarySkill()
    await writeFile(join(withSidecar, 'SKILL.md'), 'skill\n')
    await mkdir(join(withSidecar, 'agents'), { recursive: true })
    await writeFile(join(withSidecar, 'agents', 'openai.yaml'), 'display_name: test\n')

    const official1 = new Set(['SKILL.md'])
    expect(matchingKnownSnapshot(await observeSkillPackage(edited), snapshot, official1)).toBeNull()
    expect(
      matchingKnownSnapshot(await observeSkillPackage(withSidecar), snapshot, official1)
        ?.releaseRevision
    ).toBe(1)
  })

  it('does not let an older revision launder drift on a file the current one lists', async () => {
    // Subset matching treats a path the tested revision does not list as a neighbour.
    // Left unguarded, revision 1 (SKILL.md alone) would match a revision-2 folder whose
    // references/x.md had been rewritten — reporting a tampered package as merely
    // outdated, with an update offered and no "may be modified" anywhere.
    const pristine = await temporarySkill()
    await writeFile(join(pristine, 'SKILL.md'), 'skill\n')
    const revisionOne = await observeSkillPackage(pristine)

    const tampered = await temporarySkill()
    await writeFile(join(tampered, 'SKILL.md'), 'skill\n')
    await mkdir(join(tampered, 'references'), { recursive: true })
    await writeFile(join(tampered, 'references', 'x.md'), 'attacker content\n')

    const snapshots = [
      {
        releaseRevision: 1,
        packageDigest: revisionOne.observedDigest,
        gitTreeSha: revisionOne.observedGitTreeSha,
        files: revisionOne.files
      }
    ]
    const observed = await observeSkillPackage(tampered)

    expect(
      matchingKnownSnapshot(observed, snapshots, new Set(['SKILL.md', 'references/x.md']))
    ).toBeNull()
    // The same folder is a plain sidecar case once the current bundle stops claiming
    // that path, so the guard must key on what is official — not on file count.
    expect(matchingKnownSnapshot(observed, snapshots, new Set(['SKILL.md']))?.releaseRevision).toBe(
      1
    )
  })

  it('hashes official paths for the lock without hiding an upstream file it added', async () => {
    const clean = await temporarySkill()
    await writeFile(join(clean, 'SKILL.md'), 'skill\n')
    const source = await observeSkillPackage(clean)

    const withSidecar = await temporarySkill()
    await writeFile(join(withSidecar, 'SKILL.md'), 'skill\n')
    await mkdir(join(withSidecar, 'agents'), { recursive: true })
    await writeFile(join(withSidecar, 'agents', 'openai.yaml'), 'display_name: test\n')
    const sidecarObserved = await observeSkillPackage(withSidecar)
    const officialPaths = new Set(['SKILL.md'])

    // A sidecar folder reaches the lock's source-tree hash only once scoped.
    expect(sidecarObserved.observedGitTreeSha).not.toBe(source.observedGitTreeSha)
    expect(officialPathsGitTreeSha(sidecarObserved, officialPaths)).toBe(source.observedGitTreeSha)

    // An upstream revision that ADDS a file puts it in the lock's own tree, so the
    // whole-folder hash has to survive alongside — scoping it away would re-break the
    // clean install this check exists to recognise (#11220).
    const upstream = await temporarySkill()
    await writeFile(join(upstream, 'SKILL.md'), 'skill\n')
    await mkdir(join(upstream, 'references'), { recursive: true })
    await writeFile(join(upstream, 'references', 'new.md'), 'shipped upstream\n')
    const upstreamObserved = await observeSkillPackage(upstream)
    // The lock is the source tree the CLI installed, derived independently of the
    // observation under test — comparing the observation to itself would assert nothing.
    const upstreamLock = (await observeSkillPackage(await copyOf(upstream))).observedGitTreeSha

    expect(officialPathsGitTreeSha(upstreamObserved, officialPaths)).not.toBe(upstreamLock)
    expect(upstreamObserved.observedGitTreeSha).toBe(upstreamLock)
  })

  it('scopes the lock hash to the current bundle, not every path ever shipped', async () => {
    // A file an older revision shipped and the current one dropped is a stale leftover,
    // not part of what the updater installed. Scoping to the union of all revisions would
    // drag it back into the hash purely because its name was once official, and the copy
    // would read "may be modified" over bytes the CLI itself wrote.
    const source = await temporarySkill()
    await writeFile(join(source, 'SKILL.md'), 'skill\n')
    const lock = (await observeSkillPackage(source)).observedGitTreeSha

    const withLeftover = await temporarySkill()
    await writeFile(join(withLeftover, 'SKILL.md'), 'skill\n')
    await mkdir(join(withLeftover, 'references'), { recursive: true })
    await writeFile(join(withLeftover, 'references', 'legacy.md'), 'dropped after rev 1\n')
    const observed = await observeSkillPackage(withLeftover)

    expect(officialPathsGitTreeSha(observed, new Set(['SKILL.md']))).toBe(lock)
    // The union of every revision's paths — what scoping must NOT use.
    expect(
      officialPathsGitTreeSha(observed, new Set(['SKILL.md', 'references/legacy.md']))
    ).not.toBe(lock)
  })

  it('does not hand the lock an empty tree when no official path is present', async () => {
    // git's empty-tree sha is a real, matchable value; returning it would let a lock that
    // ever recorded an empty source tree vouch for any folder holding nothing official.
    const root = await temporarySkill()
    await mkdir(join(root, 'agents'), { recursive: true })
    await writeFile(join(root, 'agents', 'openai.yaml'), 'display_name: test\n')
    const observed = await observeSkillPackage(root)

    expect(officialPathsGitTreeSha(observed, new Set(['SKILL.md']))).toBe(
      observed.observedGitTreeSha
    )
    expect(officialPathsGitTreeSha(observed, new Set(['SKILL.md']))).not.toBe(
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    )
  })

  it('uses exact bytes for executable and binary files', async () => {
    const executable = describeObservedSkillFile('run.sh', Buffer.from('#!/bin/sh\r\n'), true)
    const binary = describeObservedSkillFile('asset.bin', Buffer.from([0, 13, 10]), false)
    expect(executable.identitySha256).toBe(executable.exactSha256)
    expect(binary.identitySha256).toBe(binary.exactSha256)
    expect(binary.classification).toBe('binary')
  })

  it('orders package files by locale-independent code units', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'apple.md'), 'apple')
    await writeFile(join(root, 'Zebra.md'), 'zebra')

    const observed = await observeSkillPackage(root)

    expect(observed.files.map((file) => file.path)).toEqual(['Zebra.md', 'apple.md'])
  })

  it('rejects links and bounded-observation overflows', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill')
    if (process.platform !== 'win32') {
      await symlink(join(root, 'SKILL.md'), join(root, 'linked.md'))
      await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-link')
      await rm(join(root, 'linked.md'))
    }
    await expect(
      observeSkillPackage(root, {
        maximumDepth: 1,
        maximumEntries: 0,
        maximumFiles: 1,
        maximumSingleFileBytes: 10,
        maximumTotalBytes: 10
      })
    ).rejects.toThrow('skill-package-entry-limit')
  })

  it.runIf(process.platform !== 'win32')('tracks executable mode in package identity', async () => {
    const root = await temporarySkill()
    await mkdir(join(root, 'scripts'))
    const script = join(root, 'scripts', 'run.sh')
    await writeFile(script, '#!/bin/sh\n')
    await chmod(script, 0o755)
    const observed = await observeSkillPackage(root)
    expect(observed.files[0]?.executable).toBe(true)
  })
})
