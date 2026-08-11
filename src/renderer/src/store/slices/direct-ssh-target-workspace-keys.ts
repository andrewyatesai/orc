import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo, Worktree } from '../../../../shared/types'

// Why: the ledger operates on the terminal workspace keys owned by a direct-SSH target. This mirrors
// the fork's established reconnect scoping (a target's remote repos + their host-matched worktrees)
// rather than pulling in the full host-lineage target-scope resolver from the deferred coordinator stratum.
export function resolveDirectSshTargetTerminalWorkspaceKeys(
  state: { repos: readonly Repo[]; worktreesByRepo: Record<string, readonly Worktree[]> },
  targetId: string
): Set<string> {
  const remoteRepos = state.repos.filter((repo) => repo.connectionId === targetId)
  const keys = new Set<string>()
  if (remoteRepos.length === 0) {
    return keys
  }
  for (const worktree of Object.values(state.worktreesByRepo).flat()) {
    if (
      remoteRepos.some(
        (repo) => repo.id === worktree.repoId && worktree.hostId === getRepoExecutionHostId(repo)
      )
    ) {
      keys.add(worktree.id)
    }
  }
  return keys
}
