import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { renameDurable, syncDirectory } from '../durable-file-write'
import type { BundledSkillTargetClassification } from './bundled-skill-target-classification'
import {
  acquireSkillPackageSwapLock,
  skillPackageSwapLockPath,
  SWAP_LOCK_WAIT_MS
} from './bundled-skill-swap-lock'
import {
  reconcileSkillPackageScratch,
  siblingScratchPath,
  writeSkillPackageSwapJournal
} from './bundled-skill-swap-recovery'
import type { GloballyUpdatableSkillLockState } from './skill-update-registration'

export type SkillPackageFileToWrite = {
  /** Manifest path: '/' separated, converted to the host separator here. */
  path: string
  bytes: Buffer
  executable: boolean
}

/** A destination that stopped matching what authorised the write; never a failure to retry. */
export class SkillPackageSwapRefused extends Error {
  constructor(reason: string) {
    super(`skill-package-swap-refused: ${reason}`)
    this.name = 'SkillPackageSwapRefused'
  }
}

export type SkillPackageSwapOptions = {
  /** Re-checked under the lock immediately before displacement; a string aborts the swap. */
  revalidate?: () => Promise<string | null>
}

/**
 * The displacement policy, re-read under the lock instead of trusted from earlier.
 *
 * Classification runs before the package is staged. By the time the rename comes due,
 * npx may have registered the name, or the user may have created, edited or symlinked
 * the very directory about to be moved aside and deleted. Both are refusals.
 */
export function bundledSkillSwapGuard(args: {
  name: string
  expected: BundledSkillTargetClassification
  reclassify: () => Promise<BundledSkillTargetClassification>
  relock: () => Promise<GloballyUpdatableSkillLockState>
}): () => Promise<string | null> {
  return async () => {
    const [lock, current] = await Promise.all([args.relock(), args.reclassify()])
    if (lock.status === 'unreadable' || lock.locks.has(args.name)) {
      return `npx-lock-now-owns: ${args.name}`
    }
    return current.state === args.expected.state &&
      current.resolvedPath === args.expected.resolvedPath
      ? null
      : `destination-changed: ${current.state}`
  }
}

// Why: the payload reader vets manifest paths, but this is the last step before the
// filesystem — a caller that bypasses that reader must still not escape the staging
// directory. ':' names a Windows stream and '\' separates there, so neither is a
// plain file name anywhere.
const UNSAFE_PATH_SEGMENT = /^$|^\.\.?$|[\\:]/
const NUL = '\u0000'

function stagedFilePath(stagingPath: string, manifestPath: string): string {
  const segments = manifestPath.split('/')
  if (segments.some((segment) => UNSAFE_PATH_SEGMENT.test(segment) || segment.includes(NUL))) {
    throw new Error(`skill-package-unsafe-path: ${manifestPath}`)
  }
  return join(stagingPath, segments.join(sep))
}

// Staging is always a fresh directory, so `open`'s mode always applies (minus umask).
async function writeFsyncedFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, 'w', mode)
  try {
    await handle.writeFile(bytes)
    // Why: fsync before the rename, or the swap can expose zero-length files.
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function stagePackage(
  stagingPath: string,
  files: readonly SkillPackageFileToWrite[]
): Promise<void> {
  const directories = new Set([stagingPath])
  await mkdir(stagingPath, { recursive: true })
  for (const file of files) {
    const destination = stagedFilePath(stagingPath, file.path)
    const directory = dirname(destination)
    if (!directories.has(directory)) {
      await mkdir(directory, { recursive: true })
      directories.add(directory)
    }
    // Why: the shipped payload is written by a plain copy that drops the mode,
    // so the manifest's own `executable` flag is the only truth about it.
    await writeFsyncedFile(destination, file.bytes, file.executable ? 0o755 : 0o644)
  }
  for (const directory of directories) {
    await syncDirectory(directory)
  }
}

/**
 * What the destination was when this write was authorised.
 *
 * Inode and realpath catch the directory being replaced or symlinked underneath us;
 * mtime and size catch entries appearing inside it. An edit to a file already there
 * is only visible to the caller's own `revalidate`, which re-hashes the package.
 */
async function destinationIdentity(packagePath: string): Promise<string> {
  const stats = await lstat(packagePath).catch(() => null)
  if (!stats) {
    return 'absent'
  }
  const target = await realpath(packagePath).catch(() => packagePath)
  return [stats.dev, stats.ino, stats.mode & 0o170000, stats.mtimeMs, stats.size, target].join('|')
}

/**
 * Replace `packagePath` with exactly `files`, or leave it untouched.
 *
 * A package half-written in place would hash to content no snapshot knows, and the
 * install classifier reads that as the user's own edit — permanently refusing to
 * repair it. So the whole package is staged in a sibling directory and swapped in
 * by rename. The old copy moves aside first rather than being renamed over:
 * Windows rejects a rename onto an existing directory, and keeping it addressable
 * is what allows a failed swap to be rolled back.
 *
 * The two renames are not one operation. The intent is journalled between them, so a
 * process killed in that window leaves a package the next run can put back — the
 * in-process rollback below only ever covers a swap that failed while we were alive.
 */
export async function writeSkillPackageAtomically(
  packagePath: string,
  files: readonly SkillPackageFileToWrite[],
  options: SkillPackageSwapOptions = {}
): Promise<void> {
  await mkdir(dirname(packagePath), { recursive: true })
  const release = await acquireSkillPackageSwapLock(packagePath, SWAP_LOCK_WAIT_MS)
  if (!release) {
    throw new Error(`skill-package-swap-locked: ${skillPackageSwapLockPath(packagePath)}`)
  }
  const stagingPath = siblingScratchPath(packagePath, 'staging')
  let displacedPath: string | null = null
  let journalPath: string | null = null
  let discardDisplaced = false
  try {
    await reconcileSkillPackageScratch(packagePath)
    const authorised = await destinationIdentity(packagePath)
    await stagePackage(stagingPath, files)
    const refusal = (await options.revalidate?.()) ?? null
    if (refusal !== null || (await destinationIdentity(packagePath)) !== authorised) {
      throw new SkillPackageSwapRefused(refusal ?? 'destination-identity-changed')
    }
    if (authorised !== 'absent') {
      displacedPath = siblingScratchPath(packagePath, 'replaced')
      journalPath = await writeSkillPackageSwapJournal({
        version: 1,
        packagePath,
        displacedPath,
        stagingPath
      })
      await rename(packagePath, displacedPath)
    }
    try {
      await renameDurable(stagingPath, packagePath)
      discardDisplaced = true
    } catch (error) {
      if (displacedPath) {
        try {
          await rename(displacedPath, packagePath)
          discardDisplaced = true
        } catch {
          throw new Error(
            `skill-package-swap-failed; previous package preserved at ${displacedPath}`,
            { cause: error }
          )
        }
      }
      throw error
    }
  } finally {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
    // Only ever discarded once the package it held is back in place, or superseded.
    if (displacedPath && discardDisplaced) {
      await rm(displacedPath, { recursive: true, force: true }).catch(() => undefined)
    }
    // Kept when the package is not in place: that is precisely what recovery reads.
    if (journalPath && discardDisplaced) {
      await rm(journalPath, { force: true }).catch(() => undefined)
    }
    await release()
  }
}
