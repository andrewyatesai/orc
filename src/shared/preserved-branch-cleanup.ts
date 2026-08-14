import type { ExecutionHostId } from './execution-host'

export type PreservedBranchCleanup = {
  worktreeId: string
  branchName: string
  expectedHead?: string
  hostId?: ExecutionHostId
  runtimeEnvironmentId?: string
}

// Scope a pending cleanup by (host, runtime-env, worktree) so the same
// worktreeId preserved on two hosts keeps distinct force-delete routes.
export function preservedBranchCleanupScopeKey(
  cleanup: Pick<PreservedBranchCleanup, 'worktreeId' | 'hostId' | 'runtimeEnvironmentId'>
): string {
  return [cleanup.hostId ?? '', cleanup.runtimeEnvironmentId ?? '', cleanup.worktreeId].join('\0')
}

export function preservedBranchCleanupKey(cleanup: PreservedBranchCleanup): string {
  return [
    preservedBranchCleanupScopeKey(cleanup),
    cleanup.branchName,
    cleanup.expectedHead ?? ''
  ].join('\0')
}
