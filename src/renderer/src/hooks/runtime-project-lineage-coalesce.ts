import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/types'

/** Bound concurrent repo probes so one coalesced repo event can't flood the renderer. */
const DEFAULT_REFRESH_CONCURRENCY = 5

export type RuntimeProjectRepo = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export type RuntimeProjectWorktreeFetch = (
  repoId: string,
  options: { ownerHostId: ExecutionHostId; suppressRemoteLineageRefresh: true }
) => Promise<unknown>

/**
 * Refresh every runtime repo's worktree list, bounded by `concurrency`, collapsing
 * per-repo failures into one AggregateError. Each fetch suppresses its own remote
 * lineage pass because the caller owns a single final host-wide lineage snapshot —
 * so N repos on a host stop triggering N redundant lineage probes.
 */
export async function refreshRuntimeProjectWorktrees(
  repos: readonly RuntimeProjectRepo[],
  fetchWorktrees: RuntimeProjectWorktreeFetch,
  concurrency = DEFAULT_REFRESH_CONCURRENCY
): Promise<void> {
  let nextIndex = 0
  const failures: { repoId: string; error: unknown }[] = []
  const workerCount = Math.min(concurrency, repos.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < repos.length) {
        const index = nextIndex
        nextIndex += 1
        const repo = repos[index]
        try {
          // Why: a runtime repo can share its id with a local checkout; scope the refresh to the owning host's rows.
          await fetchWorktrees(repo.id, {
            ownerHostId: getRepoExecutionHostId(repo),
            suppressRemoteLineageRefresh: true
          })
        } catch (error) {
          failures.push({ repoId: repo.id, error })
        }
      }
    })
  )
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Failed to refresh ${failures.length} runtime project worktree(s): ${failures
        .map((failure) => failure.repoId)
        .join(', ')}`
    )
  }
}

/**
 * Run the bulk repo refresh, then one final host-wide lineage refresh. A failed repo
 * refresh must not strand the lineage snapshot, so the lineage pass still runs; when
 * both phases fail, both errors are retained in an AggregateError.
 */
export async function refreshRuntimeProjectWorktreesAndLineage(
  refreshWorktrees: () => Promise<void>,
  refreshLineage: () => Promise<void>
): Promise<void> {
  let worktreeFailure: { error: unknown } | null = null
  try {
    await refreshWorktrees()
  } catch (error) {
    worktreeFailure = { error }
  }
  try {
    await refreshLineage()
  } catch (lineageError) {
    if (!worktreeFailure) {
      throw lineageError
    }
    throw new AggregateError(
      [worktreeFailure.error, lineageError],
      'Failed to refresh runtime project worktrees and lineage'
    )
  }
  if (worktreeFailure) {
    throw worktreeFailure.error
  }
}
