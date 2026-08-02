import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { renameDurable, syncDirectory } from '../durable-file-write'

export type SkillPackageFileToWrite = {
  /** Manifest path: '/' separated, converted to the host separator here. */
  path: string
  bytes: Buffer
  executable: boolean
}

function siblingScratchPath(packagePath: string, kind: string): string {
  return join(
    dirname(packagePath),
    `.${basename(packagePath)}.orca-${kind}-${randomBytes(6).toString('hex')}`
  )
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
    const destination = join(stagingPath, file.path.split('/').join(sep))
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

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
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
 */
export async function writeSkillPackageAtomically(
  packagePath: string,
  files: readonly SkillPackageFileToWrite[]
): Promise<void> {
  await mkdir(dirname(packagePath), { recursive: true })
  const stagingPath = siblingScratchPath(packagePath, 'staging')
  let displacedPath: string | null = null
  let discardDisplaced = false
  try {
    await stagePackage(stagingPath, files)
    if (await pathExists(packagePath)) {
      displacedPath = siblingScratchPath(packagePath, 'replaced')
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
  }
}
