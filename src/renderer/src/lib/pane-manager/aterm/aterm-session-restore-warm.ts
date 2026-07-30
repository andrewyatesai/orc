import {
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree-id'
import type { Repo, Worktree } from '../../../../../shared/types'
import { warmAtermSharedWorkerForImminentPane } from './aterm-worker-prewarm'

/** The slice of store state the restore-warm decision reads — structural so
 *  reconnectPersistedTerminals can pass its full captured state. */
export type SessionRestoreWarmSnapshot = {
  activeWorktreeId: string | null
  pendingReconnectWorktreeIds: string[]
  pendingReconnectTabByWorktree: Record<string, string[]>
  tabsByWorktree: Record<string, readonly { id: string }[]>
  worktreesByRepo: Record<string, readonly Pick<Worktree, 'id' | 'repoId' | 'hostId'>[]>
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
}

/** True when the pending reconnect set will restore at least one LOCAL terminal
 *  pane. SSH/runtime restores don't count: they defer until their host connects,
 *  so warming for them would hold a worker nobody mounts into. */
export function sessionRestoreHasLocalTerminalPanes(s: SessionRestoreWarmSnapshot): boolean {
  const worktrees = Object.values(s.worktreesByRepo).flat()
  // Panes mount only for the ACTIVE worktree at workspace-ready; warming for a
  // background local worktree while the active one is SSH would hold a worker
  // nothing mounts into.
  const candidateIds = (s.pendingReconnectWorktreeIds ?? []).filter(
    (id) => id === s.activeWorktreeId
  )
  for (const worktreeId of candidateIds) {
    const tabs = s.tabsByWorktree[worktreeId] ?? []
    const targetTabIds = s.pendingReconnectTabByWorktree[worktreeId] ?? []
    // Mirror reconnectPersistedTerminals' selection: the targeted tabs, else the first.
    const restoresATab =
      targetTabIds.length > 0
        ? targetTabIds.some((id) => tabs.some((tab) => tab.id === id))
        : tabs.length > 0
    if (!restoresATab) {
      continue
    }
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    // Same repo fallback as the deferred-SSH stash: SSH worktrees can be absent
    // from worktreesByRepo at cold start while their repo (with connectionId) is
    // loaded — without it an SSH-only restore would read as local here.
    const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
    const repo = s.repos.find((entry) => entry.id === repoId)
    // Unresolvable worktree AND repo defaults to local on purpose: folder
    // workspaces and the floating terminal restore locally without either.
    const hostId = getWorktreeExecutionHostId(worktree ?? { hostId: undefined }, repo)
    if (parseExecutionHostId(hostId)?.kind === 'local') {
      return true
    }
  }
  return false
}

/** Kick the aterm engine warm path when the restoring session will mount local
 *  terminal panes. Why now, not at pane mount: panes mount only after
 *  workspaceSessionReady flips at the END of reconnect, wasting a window in
 *  which the multi-second cold boot (wasm compile + worker spawn + font IPC)
 *  could already be running. */
let warmAttempted = false

export function warmAtermEngineForSessionRestore(snapshot: SessionRestoreWarmSnapshot): void {
  // Once per renderer session: reconnectPersistedTerminals also re-runs from
  // applyRemoteWorkspaceSnapshot on SSH remote-workspace syncs — cold start is
  // always the first invocation, and only it should warm.
  if (warmAttempted) {
    return
  }
  warmAttempted = true
  if (!sessionRestoreHasLocalTerminalPanes(snapshot)) {
    return
  }
  warmAtermSharedWorkerForImminentPane()
}

export function resetSessionRestoreWarmForTest(): void {
  warmAttempted = false
}
