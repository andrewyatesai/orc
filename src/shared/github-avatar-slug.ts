import type { GitHubRepositoryIdentity } from './types'

/**
 * Pick the owner whose avatar represents a repo, given its `origin` and fork parent.
 * Why: a same-name fork is a personal copy, so it reads as the parent project; a
 * renamed fork is its own project and keeps its own owner.
 */
export function githubAvatarSlug(
  origin: GitHubRepositoryIdentity | null | undefined,
  upstream: GitHubRepositoryIdentity | null | undefined
): GitHubRepositoryIdentity | null {
  const renamedFork =
    !!origin && !!upstream && origin.repo.toLowerCase() !== upstream.repo.toLowerCase()
  return renamedFork ? origin : (upstream ?? origin ?? null)
}
