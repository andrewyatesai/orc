import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'

function normalize(absolutePath: string): string {
  return normalizeAbsolutePathForComparison(absolutePath)
}

function owner(runtimeEnvironmentId: string | null | undefined): string | null {
  return runtimeEnvironmentId?.trim() || null
}

// --- TTL stamp registry: per-path source/target echo suppression (#9506) ---
// Why: an in-app move/rename re-homes the open tab to the new path (carrying its
// draft) and then physically relocates the file, which the worktree watcher
// reports as delete(old)+create(new) a few ms later. Because the tab already
// lives at the new path, that echo looks like an external write landing on a
// dirty tab and raises a spurious "changed on disk" banner. This is the move
// analog of editor-self-write-registry: stamp the source+target paths right
// before the on-disk rename so the watch hook recognizes the move's own echo and
// suppresses it, bounded by a short TTL so a genuinely external edit after the
// window still surfaces. A move carries no bytes to echo-verify the way a
// self-write does, so suppression within the TTL is a documented, bounded
// trade-off (the draft is preserved regardless of the banner).
const SELF_MOVE_TTL_MS = 750
// Why: SSH/runtime watcher echoes travel a poll-plus-network path and can land
// seconds after the rename, so remote moves need a wider window.
export const SELF_MOVE_REMOTE_TTL_MS = 3000
// Why: cap above realistic bulk directory-move sizes so a large move never
// self-evicts its own not-yet-echoed stamps.
const SELF_MOVE_MAX_STAMPS = 8192

export type SelfMoveRole = 'source' | 'target'

type SelfMoveStamp = {
  expiresAt: number
}

const stamps = new Map<string, SelfMoveStamp>()

function selfMoveKey(
  role: SelfMoveRole,
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): string {
  return `${role}::${owner(runtimeEnvironmentId) ?? 'client'}::${normalize(absolutePath)}`
}

function pruneExpiredSelfMoves(now = Date.now()): void {
  for (const [key, stamp] of stamps) {
    if (now > stamp.expiresAt) {
      stamps.delete(key)
    }
  }
}

function enforceSelfMoveStampLimit(): void {
  while (stamps.size > SELF_MOVE_MAX_STAMPS) {
    const oldest = stamps.keys().next().value
    if (oldest === undefined) {
      break
    }
    stamps.delete(oldest)
  }
}

export function recordSelfMove(
  role: SelfMoveRole,
  absolutePath: string,
  runtimeEnvironmentId?: string | null,
  ttlMs: number = SELF_MOVE_TTL_MS
): void {
  const now = Date.now()
  pruneExpiredSelfMoves(now)
  const key = selfMoveKey(role, absolutePath, runtimeEnvironmentId)
  // Why: a missing watcher echo should not leave a stale stamp resident for the
  // whole renderer session; re-stamping refreshes the window from the write.
  stamps.delete(key)
  stamps.set(key, { expiresAt: now + ttlMs })
  enforceSelfMoveStampLimit()
}

export function clearSelfMove(
  role: SelfMoveRole,
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): void {
  stamps.delete(selfMoveKey(role, absolutePath, runtimeEnvironmentId))
}

export function hasRecentSelfMove(
  role: SelfMoveRole,
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): boolean {
  const key = selfMoveKey(role, absolutePath, runtimeEnvironmentId)
  const stamp = stamps.get(key)
  if (!stamp) {
    return false
  }
  if (Date.now() > stamp.expiresAt) {
    stamps.delete(key)
    return false
  }
  return true
}

export function __clearSelfMoveRegistryForTests(): void {
  stamps.clear()
}

export function __getSelfMoveRegistrySizeForTests(): number {
  return stamps.size
}

// --- In-flight operation registry: coordinator-scoped source suppression ---
// Tracks Orca-owned moves in flight, for the rename + rekey duration only — no TTL, which would race a slow SSH rename.
// Source side only: while live, a watcher delete under any source ROOT is the move's own echo (prefix-matched so a file
// opened under a moving directory is covered), not an external delete — don't tombstone. Destination is verified by the coordinator.

type MoveOperation = {
  worktreeId: string
  runtimeEnvironmentId: string | null
  sourceRoots: string[]
}

const operations = new Map<string, MoveOperation>()

// Both sides are normalized (separators folded, trailing slash trimmed), so a single-separator prefix check is exact.
function isInsideOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`)
}

export function beginEditorPathMove(args: {
  operationId: string
  worktreeId: string
  runtimeEnvironmentId: string | null | undefined
  /** Move roots (fromPath); a delete under any of them is suppressed. */
  sourcePaths: readonly string[]
}): void {
  operations.set(args.operationId, {
    worktreeId: args.worktreeId,
    runtimeEnvironmentId: owner(args.runtimeEnvironmentId),
    sourceRoots: args.sourcePaths.map(normalize)
  })
}

export function settleEditorPathMove(operationId: string): void {
  operations.delete(operationId)
}

/** Cheap gate so watcher hot paths can skip per-file work when no move is live. */
export function hasActiveEditorPathMoves(): boolean {
  return operations.size > 0
}

/** True when this delete is the source side of a live Orca-owned move. */
export function isActiveMoveSourcePath(
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined,
  absolutePath: string
): boolean {
  // Runs per deleted open-editor in the fs-watcher hot path; skip the normalize regex when no move is live.
  if (operations.size === 0) {
    return false
  }
  const normalizedPath = normalize(absolutePath)
  const scopedOwner = owner(runtimeEnvironmentId)
  for (const operation of operations.values()) {
    if (operation.worktreeId !== worktreeId || operation.runtimeEnvironmentId !== scopedOwner) {
      continue
    }
    if (operation.sourceRoots.some((root) => isInsideOrEqual(root, normalizedPath))) {
      return true
    }
  }
  return false
}

export function __clearEditorPathMovesForTests(): void {
  operations.clear()
}

export function __activeEditorPathMoveCountForTests(): number {
  return operations.size
}
