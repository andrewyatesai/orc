import { describe, expect, it } from 'vitest'
import type { Repo, WorktreeMeta } from '../shared/types'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from './worktree-removal-repo-owner'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    ...overrides
  } as Repo
}

function makeSource(repos: Repo[]): {
  getRepos: () => Repo[]
  getRepo: (repoId: string) => Repo | undefined
} {
  return {
    getRepos: () => repos,
    // Mirror the real store: first id match wins, host-blind.
    getRepo: (repoId: string) => repos.find((repo) => repo.id === repoId)
  }
}

const R = 'repo-1'

describe('resolveWorktreeRemovalRepoOwner', () => {
  it('routes to the repo owned by the confirmed host when the id spans two hosts', () => {
    const local = makeRepo({ id: R, path: '/tmp/repo-local' })
    const remote = makeRepo({ id: R, path: '/tmp/repo-envb', executionHostId: 'runtime:env-b' })
    const owner = resolveWorktreeRemovalRepoOwner(makeSource([local, remote]), R, 'runtime:env-b')
    expect(owner).toEqual({ kind: 'resolved', repo: remote })
  })

  it('refuses an unqualified delete when two hosts own the id (fail closed)', () => {
    const local = makeRepo({ id: R, path: '/tmp/repo-local' })
    const remote = makeRepo({ id: R, path: '/tmp/repo-envb', executionHostId: 'runtime:env-b' })
    expect(resolveWorktreeRemovalRepoOwner(makeSource([local, remote]), R)).toEqual({
      kind: 'ambiguous'
    })
  })

  it('resolves a single unqualified owner through the legacy getRepo path', () => {
    const only = makeRepo({ id: R })
    expect(resolveWorktreeRemovalRepoOwner(makeSource([only]), R)).toEqual({
      kind: 'resolved',
      repo: only
    })
  })

  it('reports missing when the confirmed host owns no matching repo', () => {
    const local = makeRepo({ id: R, path: '/tmp/repo-local' })
    expect(resolveWorktreeRemovalRepoOwner(makeSource([local]), R, 'runtime:env-b')).toEqual({
      kind: 'missing'
    })
  })
})

describe('resolveWorktreeRemovalMetadata', () => {
  const meta = (overrides: Partial<WorktreeMeta>): WorktreeMeta =>
    ({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      ...overrides
    }) as WorktreeMeta

  function metaSource(repos: Repo[], metaById: Record<string, WorktreeMeta>) {
    return {
      getRepos: () => repos,
      getWorktreeMeta: (worktreeId: string): WorktreeMeta | undefined => metaById[worktreeId]
    }
  }

  it('returns the single-owner metadata regardless of host', () => {
    const worktreeId = `${R}::/tmp/wt`
    const source = metaSource([makeRepo({ id: R })], {
      [worktreeId]: meta({ hostId: 'runtime:env-b' })
    })
    expect(resolveWorktreeRemovalMetadata(source, R, worktreeId, 'local')?.hostId).toBe(
      'runtime:env-b'
    )
  })

  it('withholds metadata stamped for another host once the id is shared', () => {
    const worktreeId = `${R}::/tmp/wt`
    const source = metaSource(
      [makeRepo({ id: R, path: '/a' }), makeRepo({ id: R, path: '/b', executionHostId: 'runtime:env-b' })],
      { [worktreeId]: meta({ hostId: 'runtime:env-b' }) }
    )
    expect(resolveWorktreeRemovalMetadata(source, R, worktreeId, 'local')).toBeUndefined()
    expect(resolveWorktreeRemovalMetadata(source, R, worktreeId, 'runtime:env-b')?.hostId).toBe(
      'runtime:env-b'
    )
  })
})
