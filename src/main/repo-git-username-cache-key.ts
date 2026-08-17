import type { Repo } from '../shared/types'
import { getRepoExecutionHostId } from '../shared/execution-host'

/** Separator that can't appear in a host id or filesystem path, so (host, path) pairs never collide. */
const CACHE_KEY_SEPARATOR = String.fromCharCode(0)

/**
 * Cache key for a repo's resolved git username. Host-scoped because the same checkout path can exist
 * on local, SSH, and runtime hosts with different `user.name`, and a path-only key hydrates one
 * host's username onto another (wrong `git-username` branch prefix).
 */
export function repoGitUsernameCacheKey(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
): string {
  return `${getRepoExecutionHostId(repo)}${CACHE_KEY_SEPARATOR}${repo.path}`
}
