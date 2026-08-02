import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type {
  SkillBundleManifest,
  SkillKnownSnapshot,
  SkillSnapshotRegistry
} from '../../shared/skill-freshness'
import { gitBlobSha, skillPackageGitTreeSha } from './skill-git-tree-identity'
import { describeObservedSkillFile, skillPackageDigest } from './skill-package-identity'

/** Files must be listed in `observeSkillPackage` traversal order: code-unit sorted per directory. */
export type BundledSkillFixtureFile = { path: string; content: string; executable?: boolean }

export type BundledSkillFixtureRevision = {
  releaseRevision: number
  files: BundledSkillFixtureFile[]
}

/** Revisions ascend; the last one is what the fixture bundle ships as current. */
export type BundledSkillFixtureSkill = {
  name: string
  revisions: BundledSkillFixtureRevision[]
  /** Shipping an older revision as current is how a newer-known copy is staged. */
  currentRevisionIndex?: number
}

export async function makeTemporaryDirectory(prefix: string): Promise<string> {
  // Real path throughout: macOS hands out /var temp dirs that resolve to /private/var.
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

export function skillSnapshotFixture(
  files: readonly BundledSkillFixtureFile[],
  releaseRevision: number
): SkillKnownSnapshot {
  const identities = files.map((file) =>
    describeObservedSkillFile(file.path, Buffer.from(file.content), file.executable === true)
  )
  return {
    releaseRevision,
    packageDigest: skillPackageDigest(identities),
    gitTreeSha: skillPackageGitTreeSha(
      files.map((file) => ({
        path: file.path,
        executable: file.executable === true,
        blobSha: gitBlobSha(Buffer.from(file.content))
      }))
    ),
    files: identities
  }
}

export async function writeSkillPackageFiles(
  packagePath: string,
  files: readonly BundledSkillFixtureFile[]
): Promise<void> {
  for (const file of files) {
    const destination = join(packagePath, file.path.split('/').join(sep))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.content, { mode: file.executable === true ? 0o755 : 0o644 })
  }
}

export async function writeSkillBundleFixture(args: {
  resourceRoot: string
  skills: readonly BundledSkillFixtureSkill[]
}): Promise<void> {
  const bundleRoot = join(args.resourceRoot, 'skills')
  await mkdir(bundleRoot, { recursive: true })
  const manifest: SkillBundleManifest = { schemaVersion: 2, skills: [] }
  const registry: SkillSnapshotRegistry = { schemaVersion: 1, skills: {} }
  for (const skill of args.skills) {
    const snapshots = skill.revisions.map((revision) =>
      skillSnapshotFixture(revision.files, revision.releaseRevision)
    )
    registry.skills[skill.name] = snapshots
    const currentIndex = skill.currentRevisionIndex ?? skill.revisions.length - 1
    manifest.skills.push({
      name: skill.name,
      sourcePath: `skills/${skill.name}`,
      ...snapshots[currentIndex]
    })
    await writeSkillPackageFiles(
      join(bundleRoot, 'packages', skill.name),
      skill.revisions[currentIndex].files
    )
  }
  await Promise.all([
    writeFile(join(bundleRoot, 'current-manifest.json'), JSON.stringify(manifest)),
    writeFile(join(bundleRoot, 'snapshot-registry.json'), JSON.stringify(registry)),
    writeFile(
      join(bundleRoot, 'release-mapping.json'),
      JSON.stringify({ schemaVersion: 1, releases: [] })
    )
  ])
}

/** The updater's lock, in the shape `readGloballyUpdatableSkillLocks` accepts. */
export async function writeGlobalSkillLockFixture(args: {
  homeDir: string
  skills: Record<string, string>
}): Promise<void> {
  await mkdir(join(args.homeDir, '.agents'), { recursive: true })
  await writeFile(
    join(args.homeDir, '.agents', '.skill-lock.json'),
    JSON.stringify({
      version: 3,
      skills: Object.fromEntries(
        Object.entries(args.skills).map(([name, skillFolderHash]) => [
          name,
          {
            skillFolderHash,
            skillPath: join(args.homeDir, '.agents', 'skills', name),
            source: 'https://example.invalid/skills'
          }
        ])
      )
    })
  )
}
