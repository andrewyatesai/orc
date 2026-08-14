import type { Worktree } from '../../../../shared/types'

// Why: a captured id alone can be reused by a re-paired row; the instanceId pins the exact row a delete was chosen against.
export type WorktreeDeleteIdentity = Pick<Worktree, 'id' | 'instanceId'>

export type WorktreeDeleteOptions = {
  expectedInstanceId?: string
}

export function resolveWorktreeBatchDeleteTargets(
  requestedWorktrees: readonly string[] | readonly WorktreeDeleteIdentity[],
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree[] | null {
  // Why: a stale selection can list the same id twice; collapse it so a destructive delete runs once per identity.
  const uniqueRequests = Array.from(
    new Map(
      requestedWorktrees.map(
        (request) => [typeof request === 'string' ? request : request.id, request] as const
      )
    ).values()
  )
  const targets: Worktree[] = []
  for (const request of uniqueRequests) {
    const worktreeId = typeof request === 'string' ? request : request.id
    const target = worktreeMap.get(worktreeId) ?? null
    // Why: an identity request pinned a specific row; if it vanished or re-paired, fail the whole batch closed.
    if (typeof request !== 'string' && (!target || target.instanceId !== request.instanceId)) {
      return null
    }
    if (target && !target.isMainWorktree) {
      targets.push(target)
    }
  }
  return targets
}
