import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/types'

/**
 * Preserve a manual sidebar order that a drag-reorder committed while a
 * worktree-listing refresh was in flight.
 *
 * Why: a refresh response can predate a completed drag. Its rows still carry the
 * pre-drag `manualOrder`, so merging them verbatim rolls the sidebar back to the
 * stale order until the next refresh. When a row's `manualOrder` moved between
 * the request's start snapshot and the current store, that move is the newer
 * optimistic rank — keep it and let the listing supply everything else.
 *
 * Only rows on the refresh host are considered, so a duplicate repo id under a
 * second host cannot cross-match and pin the wrong rank.
 */
function preserveConcurrentManualOrder<T extends Worktree>(
  incoming: T[],
  requestStarted: readonly Worktree[] | undefined,
  current: readonly Worktree[] | undefined,
  matchesRefreshHost: (worktree: Worktree) => boolean
): T[] {
  if (!requestStarted || !current) {
    return incoming
  }
  const startedById = new Map(
    requestStarted.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  const currentById = new Map(
    current.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  let reconciled: T[] | null = null
  for (const [index, worktree] of incoming.entries()) {
    const started = startedById.get(worktree.id)
    const latest = currentById.get(worktree.id)
    if (!started || !latest || started.manualOrder === latest.manualOrder) {
      continue
    }
    reconciled ??= [...incoming]
    reconciled[index] = { ...worktree, manualOrder: latest.manualOrder }
  }
  return reconciled ?? incoming
}

/** Apply {@link preserveConcurrentManualOrder} to a listing result in place. */
export function preserveConcurrentManualOrderInListing(
  refresh: DetectedWorktreeListResult,
  requestStarted: readonly Worktree[] | undefined,
  current: readonly Worktree[] | undefined,
  matchesRefreshHost: (worktree: Worktree) => boolean
): DetectedWorktreeListResult {
  const worktrees = preserveConcurrentManualOrder(
    refresh.worktrees,
    requestStarted,
    current,
    matchesRefreshHost
  )
  return worktrees === refresh.worktrees ? refresh : { ...refresh, worktrees }
}
