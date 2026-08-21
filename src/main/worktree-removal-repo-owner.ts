import { getRepoExecutionHostId, type ExecutionHostId } from '../shared/execution-host'
import type { Repo, WorktreeMeta } from '../shared/types'

export type WorktreeRemovalRepoSource = {
  getRepos: () => readonly Repo[]
  getRepo: (repoId: string) => Repo | undefined
}

export type WorktreeRemovalRepoOwner =
  | { kind: 'resolved'; repo: Repo }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

/**
 * Which repo a destructive worktree removal belongs to (STA-4343).
 *
 * A repo id can be registered once per execution host, so a bare `repoId::path`
 * removal id names two workspaces when two hosts own the repo. Honor the caller's
 * host qualifier; without one, refuse rather than delete a same-id workspace on
 * whichever host `getRepo` happens to return first.
 */
export function resolveWorktreeRemovalRepoOwner(
  store: WorktreeRemovalRepoSource,
  repoId: string,
  hostId?: ExecutionHostId
): WorktreeRemovalRepoOwner {
  const matches = store
    .getRepos()
    .filter((repo) => repo.id === repoId && (!hostId || getRepoExecutionHostId(repo) === hostId))
  if (matches.length === 1 && matches[0]) {
    return { kind: 'resolved', repo: matches[0] }
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous' }
  }
  const legacyMatch = store.getRepo(repoId)
  return legacyMatch && (!hostId || getRepoExecutionHostId(legacyMatch) === hostId)
    ? { kind: 'resolved', repo: legacyMatch }
    : { kind: 'missing' }
}

/**
 * Worktree metadata for a removal, scoped to the removing host.
 *
 * Metadata is keyed by the bare `repoId::path`, so when two hosts own the repo the
 * single entry belongs to at most one of them. Returning it unconditionally would
 * apply the other host's saved push target; gate on the stamped host once the id
 * is shared.
 */
export function resolveWorktreeRemovalMetadata(
  store: Pick<WorktreeRemovalRepoSource, 'getRepos'> & {
    getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  },
  repoId: string,
  worktreeId: string,
  hostId: ExecutionHostId
): WorktreeMeta | undefined {
  const meta = store.getWorktreeMeta(worktreeId)
  if (!meta) {
    return undefined
  }
  const repoOwnerCount = store.getRepos().filter((repo) => repo.id === repoId).length
  if (repoOwnerCount <= 1) {
    return meta
  }
  return meta.hostId === hostId ? meta : undefined
}
