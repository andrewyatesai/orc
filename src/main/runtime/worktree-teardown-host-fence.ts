// Why: worktree ids are `repoId::path` and the store keeps one per host, so a
// destructive teardown that sweeps by id alone stops a same-id workspace's
// terminals on another connection — or throws `selector_ambiguous` when two hosts
// own the id. Every destructive sweep names its owning host through this fence.

/** Presence of `resolvedWorktreeId` activates the fence; a missing connection means the local host. */
export type WorktreeTeardownHostFence = {
  resolvedWorktreeId: string
  /** SSH connection that owns the worktree; absent fences to the local (null-connection) host. */
  resolvedConnectionId?: string
}

/** True when the PTY's connection belongs to the fenced host, or when no fence is set. */
export function ptyBelongsToTeardownFence(
  ptyConnectionId: string | null,
  fence: WorktreeTeardownHostFence | undefined
): boolean {
  if (!fence) {
    return true
  }
  return ptyConnectionId === (fence.resolvedConnectionId ?? null)
}
