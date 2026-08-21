import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'
import {
  REPO_SLUG_FAILURE_TTL_MS,
  clearRepoSlugCacheValues,
  nextRepoSlugFailureRetryDelay,
  readRepoSlugCache,
  rememberRepoSlug,
  lookupReposBySlugFromCache,
  repoUpstreamIdentityKey,
  settingsForRepoOwner,
  slugByRepoId,
  slugCacheKey
} from './repo-slug-cache'

function repo(id: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId: 'local'
  }
}

describe('repo slug cache host identity', () => {
  beforeEach(() => clearRepoSlugCacheValues())

  it('does not route a GHES project row to a same-named github.com repo', () => {
    const dotCom = repo('dotcom')
    const enterprise = repo('enterprise')
    for (const [candidate, host] of [
      [dotCom, 'github.com'],
      [enterprise, 'ghe.example:8443']
    ] as const) {
      slugByRepoId.set(
        slugCacheKey(candidate.id, settingsForRepoOwner(candidate, null)),
        githubRepoIdentityKey({ owner: 'acme', repo: 'widgets', host })
      )
    }

    expect(lookupReposBySlugFromCache([dotCom, enterprise], null, 'acme/widgets')).toEqual([dotCom])
    expect(
      lookupReposBySlugFromCache([dotCom, enterprise], null, 'acme/widgets', 'ghe.example:8443')
    ).toEqual([enterprise])
  })

  it('expires negative slug resolutions so an external GHES login can recover', () => {
    const key = slugCacheKey('enterprise', null)
    rememberRepoSlug(key, null, 1_000)

    expect(readRepoSlugCache(key, 1_000)).toEqual({ hit: true, value: null })
    expect(nextRepoSlugFailureRetryDelay(new Set([key]), 1_000)).toBe(REPO_SLUG_FAILURE_TTL_MS)
    expect(readRepoSlugCache(key, 1_000 + REPO_SLUG_FAILURE_TTL_MS)).toEqual({ hit: false })
  })
})

describe('fork upstream slug matching', () => {
  beforeEach(() => clearRepoSlugCacheValues())

  function fork(id: string, upstream: Repo['upstream']): Repo {
    return { ...repo(id), upstream }
  }

  it('matches a fork through its upstream parent when origin does not (#12647)', () => {
    // The open clone's origin is a personal fork; the Project row names the parent.
    const forkRepo = fork('fork', { owner: 'acme', repo: 'orca' })
    slugByRepoId.set(
      slugCacheKey(forkRepo.id, settingsForRepoOwner(forkRepo, null)),
      githubRepoIdentityKey({ owner: 'me', repo: 'orca' })
    )

    expect(lookupReposBySlugFromCache([forkRepo], null, 'acme/orca')).toEqual([forkRepo])
    // Origin queries still resolve directly.
    expect(lookupReposBySlugFromCache([forkRepo], null, 'me/orca')).toEqual([forkRepo])
  })

  it('lets an origin clone of the upstream repo win over a fork of it', () => {
    const clone = repo('clone')
    const forkRepo = fork('fork', { owner: 'acme', repo: 'orca' })
    slugByRepoId.set(
      slugCacheKey(clone.id, settingsForRepoOwner(clone, null)),
      githubRepoIdentityKey({ owner: 'acme', repo: 'orca' })
    )
    slugByRepoId.set(
      slugCacheKey(forkRepo.id, settingsForRepoOwner(forkRepo, null)),
      githubRepoIdentityKey({ owner: 'me', repo: 'orca' })
    )

    expect(lookupReposBySlugFromCache([clone, forkRepo], null, 'acme/orca')).toEqual([clone])
  })

  it('scopes an absent upstream host to the fork origin host', () => {
    const forkRepo = fork('fork', { owner: 'acme', repo: 'orca' })
    const originKey = githubRepoIdentityKey({ owner: 'me', repo: 'orca', host: 'ghe.example:8443' })

    expect(repoUpstreamIdentityKey(forkRepo, originKey)).toBe(
      githubRepoIdentityKey({ owner: 'acme', repo: 'orca', host: 'ghe.example:8443' })
    )
  })

  it('refuses the upstream alias for a non-fork or an unresolved origin', () => {
    expect(repoUpstreamIdentityKey(repo('plain'), 'me/orca')).toBeNull()
    expect(repoUpstreamIdentityKey(fork('fork', { owner: 'acme', repo: 'orca' }), null)).toBeNull()
  })
})
