import { timeRendererStartupStep } from '../startup/startup-diagnostics'
import { useAppStore } from '../store'
import type { StartupHydrationActions } from './app-startup-hydration'

// Why (#18): the full worktree/catalog scan is not required for session recovery, so keep it off the startup-critical path.
export async function refreshRemoteCatalogAfterHydration(
  actions: StartupHydrationActions,
  isCancelled: () => boolean
): Promise<void> {
  try {
    try {
      await timeRendererStartupStep('remote-catalog-refresh', async () => {
        await actions.fetchReposForAllHosts()
        await actions.fetchProjectGroupsForAllHosts()
        await actions.fetchFolderWorkspacesForAllHosts()
      })
    } catch (err) {
      console.warn('Remote startup catalog refresh failed:', err)
    }
    if (!isCancelled()) {
      try {
        await timeRendererStartupStep('remote-worktree-refresh', async () => {
          await actions.fetchAllWorktrees()
          // Why: the startup prune only saw session-referenced repos; use the deferred scan's
          // authoritative results to drop deleted-worktree visit timestamps that would
          // otherwise accumulate unbounded (disconnected SSH stays non-authoritative and is kept).
          actions.pruneLastVisitedTimestamps()
          await actions.fetchWorktreeLineage()
        })
      } catch (err) {
        console.warn('Deferred startup worktree refresh failed:', err)
      }
    }
  } finally {
    if (!isCancelled()) {
      useAppStore.setState({ startupWorktreeRefreshCompleted: true })
    }
  }
}
