import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { renameDurable, syncDirectory } from '../durable-file-write'
import { acquireSkillPackageSwapLock } from './bundled-skill-swap-lock'

const SCRATCH_KINDS = ['staging', 'replaced'] as const
type ScratchKind = (typeof SCRATCH_KINDS)[number]

// Why: a crash mid-swap, or a Windows unlink blocked by an open handle, strands
// scratch the `finally` never got to remove. Only reclaim what is old enough that
// no concurrent write could still own it.
const STALE_SCRATCH_AGE_MS = 60 * 60 * 1000

const SWAP_JOURNAL_ENTRY = /^\.(.+)\.orca-swap\.json$/
const REPLACED_SCRATCH_ENTRY = /^\.(.+)\.orca-replaced-[0-9a-f]+$/

export function siblingScratchPath(packagePath: string, kind: ScratchKind): string {
  return join(
    dirname(packagePath),
    `.${basename(packagePath)}.orca-${kind}-${randomBytes(6).toString('hex')}`
  )
}

function scratchKindOf(packageName: string, entryName: string): ScratchKind | null {
  const prefix = `.${packageName}.orca-`
  if (!entryName.startsWith(prefix)) {
    return null
  }
  const suffix = entryName.slice(prefix.length)
  return (
    SCRATCH_KINDS.find(
      (kind) => suffix.startsWith(`${kind}-`) && /^[0-9a-f]+$/.test(suffix.slice(kind.length + 1))
    ) ?? null
  )
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

export type SkillPackageSwapJournal = {
  version: 1
  packagePath: string
  displacedPath: string
  stagingPath: string
}

function swapJournalPath(packagePath: string): string {
  return join(dirname(packagePath), `.${basename(packagePath)}.orca-swap.json`)
}

/**
 * Record the swap before the rename that starts it.
 *
 * Written in place rather than staged and renamed: a torn journal reads as no journal,
 * and the orphaned-`replaced` sweep still puts the package back from that.
 */
export async function writeSkillPackageSwapJournal(
  journal: SkillPackageSwapJournal
): Promise<string> {
  const journalPath = swapJournalPath(journal.packagePath)
  const handle = await open(journalPath, 'w')
  try {
    await handle.writeFile(JSON.stringify(journal))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(journalPath))
  return journalPath
}

async function readSwapJournal(
  journalPath: string,
  parent: string
): Promise<SkillPackageSwapJournal | null> {
  const raw = await readFile(journalPath, 'utf8').catch(() => null)
  if (raw === null) {
    return null
  }
  try {
    const journal = JSON.parse(raw) as Partial<SkillPackageSwapJournal>
    const paths = [journal.packagePath, journal.displacedPath, journal.stagingPath]
    // A journal only ever names siblings; anything else was not written by us.
    return journal.version === 1 &&
      paths.every((path) => typeof path === 'string' && dirname(path) === parent)
      ? (journal as SkillPackageSwapJournal)
      : null
  } catch {
    return null
  }
}

async function recoverJournaledSwap(
  journalPath: string,
  journal: SkillPackageSwapJournal
): Promise<void> {
  if (!(await pathExists(journal.packagePath))) {
    // Mid-swap: the package exists only under scratch, and either copy is whole —
    // staging was fsynced before this journal was written.
    const surviving = (await pathExists(journal.displacedPath))
      ? journal.displacedPath
      : (await pathExists(journal.stagingPath))
        ? journal.stagingPath
        : null
    if (surviving) {
      await renameDurable(surviving, journal.packagePath).catch(() => undefined)
    }
  }
  await rm(journal.stagingPath, { recursive: true, force: true }).catch(() => undefined)
  if (await pathExists(journal.packagePath)) {
    await rm(journal.displacedPath, { recursive: true, force: true }).catch(() => undefined)
  }
  await rm(journalPath, { force: true }).catch(() => undefined)
}

/**
 * Put one package back together and reclaim what an earlier run stranded beside it.
 *
 * `replaced` scratch is garbage only once the package is in place; while it is not,
 * that directory holds the sole surviving copy of what the swap displaced, so it is
 * restored rather than swept. Callers must already hold the package's swap lock.
 */
export async function reconcileSkillPackageScratch(packagePath: string): Promise<void> {
  const parent = dirname(packagePath)
  const packageName = basename(packagePath)
  const journalPath = swapJournalPath(packagePath)
  const journal = await readSwapJournal(journalPath, parent)
  if (journal) {
    await recoverJournaledSwap(journalPath, journal)
  }
  const [entries, packageInPlace] = await Promise.all([
    readdir(parent, { withFileTypes: true }).catch(() => []),
    pathExists(packagePath)
  ])
  const staleBefore = Date.now() - STALE_SCRATCH_AGE_MS
  let inPlace = packageInPlace
  for (const entry of entries) {
    const kind = entry.isDirectory() ? scratchKindOf(packageName, entry.name) : null
    if (!kind) {
      continue
    }
    const scratchPath = join(parent, entry.name)
    if (kind === 'replaced' && !inPlace) {
      // A swap interrupted before any build journalled it: this is the only copy left.
      inPlace = await renameDurable(scratchPath, packagePath).then(
        () => true,
        () => false
      )
      continue
    }
    // Why: `rename` leaves mtime alone, so a directory another process just
    // displaced can look ancient; ctime moves with the rename and protects it.
    const stats = await lstat(scratchPath).catch(() => null)
    if (stats && Math.max(stats.mtimeMs, stats.ctimeMs) < staleBefore) {
      await rm(scratchPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  if (!journal) {
    // A journal this build cannot parse describes a swap it cannot finish.
    await rm(journalPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Finish or undo every swap a dead process left half-applied under `rootPath`.
 *
 * Must run before anything reads the root: between the two renames the live package
 * is absent, so discovery reports the skill as gone and classification reads the
 * destination as free — while the only copy sits under a hidden scratch name that the
 * sweep deliberately preserves and, until this ran, nothing ever restored.
 */
export async function recoverInterruptedSkillPackageSwaps(rootPath: string): Promise<void> {
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => [])
  const names = new Set<string>()
  for (const entry of entries) {
    const match = SWAP_JOURNAL_ENTRY.exec(entry.name) ?? REPLACED_SCRATCH_ENTRY.exec(entry.name)
    if (match) {
      names.add(match[1])
    }
  }
  for (const name of names) {
    const packagePath = join(rootPath, name)
    // A package another process is actively swapping is not an interrupted one.
    const release = await acquireSkillPackageSwapLock(packagePath, 0)
    if (!release) {
      continue
    }
    try {
      await reconcileSkillPackageScratch(packagePath)
    } finally {
      await release()
    }
  }
}
