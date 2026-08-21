import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SkillFreshnessInstallation } from '../../shared/skill-freshness'

const GLOBAL_SKILL_LOCK_SCHEMA_VERSION = 3

type SkillUpdateRegistrationArgs = {
  homeDir?: string
  stateHome?: string | null
}

/**
 * What the npx updater's lock records, or why it could not be read.
 *
 * Only `absent` means nothing is locked. `unreadable` is a lock that exists but
 * cannot be trusted — corrupt, truncated mid-write, an older schema, or denied —
 * and a caller about to write under a lock entry has to treat it as fully locked,
 * because the entries it would have to respect are exactly the ones it cannot see.
 */
export type GloballyUpdatableSkillLockState = {
  status: 'absent' | 'readable' | 'unreadable'
  locks: ReadonlyMap<string, string>
  detail: string | null
}

/**
 * Whether a placement holds exactly the bytes the updater recorded installing.
 *
 * Either hash may carry it. The lock is the git tree sha of the source folder, so a
 * folder an agent CLI dropped a sidecar into only matches once that sidecar is scoped
 * out, while an upstream revision that added a file only matches whole — that file is
 * in the lock's own tree but in no bundled snapshot. Requiring one specific hash trades
 * either #12694 or #11220 for the other.
 *
 * Not exhaustive, and deliberately so: a folder carrying BOTH a sidecar and an upstream
 * file no bundle lists matches neither hash and stays unrecognized, exactly as it does
 * without this pair. Closing that needs the sidecar gone before hashing — an observe-time
 * exclusion like `isOsMetadataSkillEntryName`, which means naming the foreign paths rather
 * than tolerating any unlisted one. Editing a listed file still matches neither hash.
 */
export function matchesUpdaterLock(
  installation: SkillFreshnessInstallation,
  lockHash: string | undefined
): boolean {
  return (
    lockHash !== undefined &&
    (installation.observedGitTreeSha === lockHash ||
      installation.observedOfficialGitTreeSha === lockHash)
  )
}

function globalSkillLockPath(args: SkillUpdateRegistrationArgs): string {
  const stateHome =
    args.stateHome === undefined
      ? args.homeDir === undefined
        ? (process.env.XDG_STATE_HOME ?? null)
        : null
      : args.stateHome
  return stateHome
    ? join(stateHome, 'skills', '.skill-lock.json')
    : join(args.homeDir ?? homedir(), '.agents', '.skill-lock.json')
}

/** Null for content this build cannot interpret; throws only when the JSON itself is broken. */
function parseGlobalSkillLock(raw: string): ReadonlyMap<string, string> | null {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const { version, skills } = parsed as { version?: unknown; skills?: unknown }
  if (
    typeof version !== 'number' ||
    version < GLOBAL_SKILL_LOCK_SCHEMA_VERSION ||
    !skills ||
    typeof skills !== 'object' ||
    Array.isArray(skills)
  ) {
    return null
  }

  return new Map(
    Object.entries(skills)
      .filter(([, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false
        }
        const entry = value as {
          skillFolderHash?: unknown
          skillPath?: unknown
          source?: unknown
        }
        return (
          typeof entry.skillFolderHash === 'string' &&
          entry.skillFolderHash.length > 0 &&
          typeof entry.skillPath === 'string' &&
          entry.skillPath.length > 0 &&
          typeof entry.source === 'string' &&
          entry.source.length > 0
        )
      })
      .map(
        ([name, value]) => [name, (value as { skillFolderHash: string }).skillFolderHash] as const
      )
  )
}

export async function readGloballyUpdatableSkillNames(
  args: SkillUpdateRegistrationArgs = {}
): Promise<ReadonlySet<string>> {
  return new Set((await readGloballyUpdatableSkillLocks(args)).keys())
}

/**
 * Each updatable skill's recorded `skillFolderHash`, keyed by name.
 *
 * The hash is what the updater believes it installed. It is deliberately
 * exposed alongside the names because `skills update` decides what to do by
 * comparing this against the source and never reads disk — so when it disagrees
 * with the bytes actually on disk, the command can only no-op.
 *
 * An unreadable lock reads as empty here. Callers that must not write under a
 * lock entry want `readGloballyUpdatableSkillLockState` instead, which keeps the
 * two apart.
 */
export async function readGloballyUpdatableSkillLocks(
  args: SkillUpdateRegistrationArgs = {}
): Promise<ReadonlyMap<string, string>> {
  return (await readGloballyUpdatableSkillLockState(args)).locks
}

export async function readGloballyUpdatableSkillLockState(
  args: SkillUpdateRegistrationArgs = {}
): Promise<GloballyUpdatableSkillLockState> {
  let raw: string
  try {
    raw = await readFile(globalSkillLockPath(args), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ENOTDIR: a component of the path is a file, so no lock can exist beneath it.
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { status: 'absent', locks: new Map(), detail: null }
      : { status: 'unreadable', locks: new Map(), detail: code ?? 'skill-lock-read-failed' }
  }
  try {
    const locks = parseGlobalSkillLock(raw)
    return locks
      ? { status: 'readable', locks, detail: null }
      : { status: 'unreadable', locks: new Map(), detail: 'skill-lock-unrecognized' }
  } catch {
    return { status: 'unreadable', locks: new Map(), detail: 'skill-lock-unparsable' }
  }
}
