import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree-id'
import type { Repo, WorkspaceSessionState, Worktree } from '../../../../../shared/types'
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

/** The raw persisted session fields the boot-snapshot warm reads. */
type StartupSessionPartition = Pick<
  WorkspaceSessionState,
  'activeWorktreeId' | 'tabsByWorktree' | 'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId'
>

/** The boot-snapshot slice the early warm reads — structural so the hydration
 *  chain passes the StartupSnapshot it already holds, unchanged. */
export type StartupSnapshotWarmSource = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  sessionPartitionsByHostId?: Partial<Record<ExecutionHostId, StartupSessionPartition>>
}

/** Project the LOCAL session partition onto the reconnect-shaped decision input.
 *  Only the local partition matters: runtime-owned worktrees are split into
 *  their own partitions (SSH deliberately stays local), so a runtime restore
 *  simply produces no candidates here. */
function toSessionRestoreWarmSnapshot(
  source: StartupSnapshotWarmSource
): SessionRestoreWarmSnapshot | null {
  const session = source.sessionPartitionsByHostId?.[LOCAL_EXECUTION_HOST_ID]
  // Without catalog rows the repo lookup carries no connectionId, and an SSH
  // restore would read as local — decline rather than hold a worker for it.
  if (!session?.activeWorktreeId || !source.repos) {
    return null
  }
  const tabsByWorktree = session.tabsByWorktree ?? {}
  // Mirrors hydrateTabsSession's derivation from the same raw session data:
  // shutdown ids are authoritative when present, else worktrees whose tabs
  // still carry a ptyId. Validation against the catalog is what hydration adds;
  // the predicate's own tab/host checks stand in for it here.
  const shutdownIds =
    session.activeWorktreeIdsOnShutdown ??
    Object.entries(tabsByWorktree)
      .filter(([, tabs]) => tabs.some((tab) => tab.ptyId))
      .map(([worktreeId]) => worktreeId)
  const remoteSessionIds = session.remoteSessionIdsByTabId ?? {}
  const pendingReconnectTabByWorktree: Record<string, string[]> = {}
  for (const worktreeId of shutdownIds) {
    const liveTabIds = (tabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.ptyId || remoteSessionIds[tab.id])
      .map((tab) => tab.id)
    if (liveTabIds.length > 0) {
      pendingReconnectTabByWorktree[worktreeId] = liveTabIds
    }
  }
  return {
    activeWorktreeId: session.activeWorktreeId,
    pendingReconnectWorktreeIds: shutdownIds,
    pendingReconnectTabByWorktree,
    tabsByWorktree,
    // The worktree catalog is not hydrated this early, so no per-worktree
    // hostId is available — safe here because `runtime:*` worktrees are the
    // only ones partitioned OUT of the local session
    // (workspace-session-host-persistence.ts:165-170), so they cannot appear in
    // this partition at all. SSH deliberately DOES stay local, and it is caught
    // by the repo-level connectionId check the predicate falls back to via the
    // repo id embedded in the composite worktree id.
    worktreesByRepo: {},
    repos: source.repos
  }
}

/** Warm from the BOOT SNAPSHOT's session partition — the earliest moment the
 *  "will restore local terminals" answer exists, ~100ms ahead of reconnect
 *  (which stays the fallback below). Declines WITHOUT spending the single
 *  attempt when the snapshot lacks the rows the local/SSH call needs, so a
 *  degraded snapshot still warms at reconnect with hydrated store state. */
export function warmAtermEngineForStartupSnapshot(
  source: StartupSnapshotWarmSource | null | undefined
): void {
  if (warmAttempted || !source) {
    return
  }
  const snapshot = toSessionRestoreWarmSnapshot(source)
  if (!snapshot || !sessionRestoreHasLocalTerminalPanes(snapshot)) {
    return
  }
  warmAttempted = true
  warmAtermSharedWorkerForImminentPane()
}

export function resetSessionRestoreWarmForTest(): void {
  warmAttempted = false
}
