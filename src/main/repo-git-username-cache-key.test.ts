import { describe, it, expect } from 'vitest'
import type { Repo } from '../shared/types'
import { repoGitUsernameCacheKey } from './repo-git-username-cache-key'

const repo = (over: Partial<Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>>) =>
  ({ path: '/home/dev/checkout', connectionId: null, executionHostId: null, ...over }) as Pick<
    Repo,
    'path' | 'connectionId' | 'executionHostId'
  >

describe('repoGitUsernameCacheKey', () => {
  it('separates the same checkout path across execution hosts', () => {
    const local = repoGitUsernameCacheKey(repo({}))
    const ssh = repoGitUsernameCacheKey(repo({ connectionId: 'box-a' }))
    const runtime = repoGitUsernameCacheKey(repo({ executionHostId: 'runtime:wsl-ubuntu' }))
    // A path-only key would collapse these three onto one row and cross-hydrate usernames.
    expect(new Set([local, ssh, runtime]).size).toBe(3)
  })

  it('is stable for the same (host, path) pair', () => {
    expect(repoGitUsernameCacheKey(repo({ connectionId: 'box-a' }))).toBe(
      repoGitUsernameCacheKey(repo({ connectionId: 'box-a' }))
    )
  })

  it('keys distinct paths on one host apart', () => {
    expect(repoGitUsernameCacheKey(repo({ path: '/home/dev/a' }))).not.toBe(
      repoGitUsernameCacheKey(repo({ path: '/home/dev/b' }))
    )
  })
})
