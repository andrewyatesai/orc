import { describe, expect, it } from 'vitest'
import {
  dropFailedGitHubRepoSlugEntries,
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  normalizeGitHubRepositorySlug
} from './github-project-repo-match'

const repos = [
  { id: 'repo-1', path: '/userhome/me/orca', displayName: 'orca' },
  { id: 'repo-2', path: '/userhome/me/other', displayName: 'other' }
]

describe('GitHub project repo matching', () => {
  it('normalizes owner/repo slugs case-insensitively', () => {
    expect(normalizeGitHubRepositorySlug(' StablyAI/Orca ')).toBe('stablyai/orca')
    expect(normalizeGitHubRepositorySlug('orca')).toBeNull()
    expect(normalizeGitHubRepositorySlug('stablyai/orca/extra')).toBeNull()
  })

  it('matches project rows by resolved repo slug before path/display heuristics', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', repos, {
        'repo-1': {
          path: '/userhome/me/orca',
          repository: { owner: 'stablyai', repo: 'orca' }
        }
      })
    ).toBe(repos[0])
  })

  it('does not pick a repo when resolved slugs are ambiguous', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', repos, {
        'repo-1': {
          path: '/userhome/me/orca',
          repository: { owner: 'stablyai', repo: 'orca' }
        },
        'repo-2': {
          path: '/userhome/me/other',
          repository: { owner: 'stablyai', repo: 'orca' }
        }
      })
    ).toBeNull()
  })

  it('falls back to exact display/path slug matching when slug resolution is unavailable', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', [
        { id: 'repo-1', path: '/userhome/me/stablyai/orca', displayName: 'orca' }
      ])
    ).toEqual({ id: 'repo-1', path: '/userhome/me/stablyai/orca', displayName: 'orca' })
  })

  it('normalizes Windows paths before path slug fallback matching', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', [
        { id: 'repo-1', path: 'C:\\userhome\\me\\stablyai\\orca', displayName: 'orca' }
      ])
    ).toEqual({ id: 'repo-1', path: 'C:\\userhome\\me\\stablyai\\orca', displayName: 'orca' })
  })

  it('does not path-match a repo whose resolved slug points somewhere else', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        [{ id: 'repo-1', path: '/userhome/me/stablyai/orca', displayName: 'orca' }],
        {
          'repo-1': {
            path: '/userhome/me/stablyai/orca',
            repository: { owner: 'fork', repo: 'orca' }
          }
        }
      )
    ).toBeNull()
  })

  it('filters project rows to rows backed by open repositories', () => {
    const rows = [
      { id: 'row-1', content: { repository: 'stablyai/orca' } },
      { id: 'row-2', content: { repository: 'other/missing' } },
      { id: 'row-3', content: { repository: null } }
    ]

    expect(
      filterGitHubProjectRowsForRepos(rows, repos, {
        'repo-1': {
          path: '/userhome/me/orca',
          repository: { owner: 'stablyai', repo: 'orca' }
        }
      }).map((row) => row.id)
    ).toEqual(['row-1'])
  })

  it('matches same-named repositories only on the active Project host', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        repos,
        {
          'repo-1': {
            path: '/userhome/me/orca',
            repository: { owner: 'stablyai', repo: 'orca', host: 'github.com' }
          },
          'repo-2': {
            path: '/userhome/me/other',
            repository: {
              owner: 'stablyai',
              repo: 'orca',
              host: 'github.acme-corp.com'
            }
          }
        },
        'github.acme-corp.com'
      )
    ).toBe(repos[1])
  })

  it('does not use hostless path heuristics for Enterprise Project rows', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        [{ id: 'repo-1', path: '/userhome/me/stablyai/orca', displayName: 'orca' }],
        {},
        'github.acme-corp.com'
      )
    ).toBeNull()
  })

  it('matches a fork through its upstream parent when origin does not (#12647)', () => {
    const forkRepos = [
      {
        id: 'fork-1',
        path: '/userhome/me/orca',
        displayName: 'orca',
        upstream: { owner: 'stablyai', repo: 'orca' }
      }
    ]

    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', forkRepos, {
        'fork-1': {
          path: '/userhome/me/orca',
          repository: { owner: 'me', repo: 'orca' }
        }
      })
    ).toBe(forkRepos[0])
  })

  it('prefers an origin clone of the upstream repo over a fork of it', () => {
    const both = [
      { id: 'clone', path: '/userhome/me/clone', displayName: 'orca' },
      {
        id: 'fork',
        path: '/userhome/me/fork',
        displayName: 'orca',
        upstream: { owner: 'stablyai', repo: 'orca' }
      }
    ]

    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', both, {
        clone: { path: '/userhome/me/clone', repository: { owner: 'stablyai', repo: 'orca' } },
        fork: { path: '/userhome/me/fork', repository: { owner: 'me', repo: 'orca' } }
      })
    ).toBe(both[0])
  })

  it('scopes an absent upstream host to the fork origin host', () => {
    const forkRepos = [
      {
        id: 'fork-1',
        path: '/userhome/me/orca',
        displayName: 'orca',
        upstream: { owner: 'stablyai', repo: 'orca' }
      }
    ]
    const slugs = {
      'fork-1': {
        path: '/userhome/me/orca',
        repository: { owner: 'me', repo: 'orca', host: 'github.acme-corp.com' }
      }
    }

    // The parent lives on the fork's Enterprise host, not github.com.
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', forkRepos, slugs, 'github.acme-corp.com')
    ).toBe(forkRepos[0])
    expect(
      findRepoForGitHubProjectRepository('stablyai/orca', forkRepos, slugs, 'github.com')
    ).toBeNull()
  })

  // Regression: a transient github.repoSlug error used to be cached as a
  // resolved "no repository", which filtered that repo's rows out forever.
  it('leaves a failed slug lookup matchable by the path fallback', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/orca',
        [{ id: 'repo-1', path: '/userhome/me/stablyai/orca', displayName: 'orca' }],
        { 'repo-1': { path: '/userhome/me/stablyai/orca', repository: null, failed: true } }
      )
    ).toEqual({ id: 'repo-1', path: '/userhome/me/stablyai/orca', displayName: 'orca' })
  })
})

describe('dropFailedGitHubRepoSlugEntries', () => {
  it('drops only the entries a retry could still resolve', () => {
    expect(
      dropFailedGitHubRepoSlugEntries({
        'repo-1': { path: '/a', repository: { owner: 'stablyai', repo: 'orca' } },
        'repo-2': { path: '/b', repository: null, failed: true },
        'repo-3': { path: '/c', repository: null }
      })
    ).toEqual({
      'repo-1': { path: '/a', repository: { owner: 'stablyai', repo: 'orca' } },
      'repo-3': { path: '/c', repository: null }
    })
  })

  // Why: the cache is a slug-effect dependency, so a fresh object on every
  // refresh would re-run the effect even when there is nothing to retry.
  it('returns the same object when nothing failed', () => {
    const cache = { 'repo-1': { path: '/a', repository: null } }
    expect(dropFailedGitHubRepoSlugEntries(cache)).toBe(cache)
  })
})
