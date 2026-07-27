/**
 * Issue #8935 — GitHub Enterprise PR work item diffs must target the Enterprise host.
 *
 * Root cause chain (pre-fix):
 * 1. parseGitHubOwnerRepo only accepts github.com → null for GHE remotes
 * 2. getPRFiles / getPRFileContents used getOwnerRepo only → null / empty
 * 3. gh api never passed --hostname → wrong host even with a forced slug
 *
 * The host now rides on the gh exec options and `applyGhHostToArgs` injects
 * `--hostname` into the argv, so (3) is asserted through the real runner helper.
 *
 * Related prior art: https://github.com/stablyai/orca/pull/8932 (@wonjerry)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  ghExecFileAsyncMock,
  getOwnerRepoForRemoteMock,
  getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemoteMock,
  isGitHubHostAuthenticatedMock,
  getWorkItemMock,
  getPRChecksMock,
  getPRCommentsMock,
  repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getEnterpriseGitHubRepoSlugForRemoteMock: vi.fn(),
  isGitHubHostAuthenticatedMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  repositoryRateLimitGuardMock: vi.fn<() => RateLimitGuardResult>(() => ({ blocked: false })),
  noteRepositoryRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  ghRepoExecOptions: vi.fn((context) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) }
  ),
  githubRepoContext: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemote: getEnterpriseGitHubRepoSlugForRemoteMock,
  isGitHubHostAuthenticated: isGitHubHostAuthenticatedMock
}))

vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock
}))

import { getPRFileContents, getWorkItemDetails } from './work-item-details'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'
import { parseGitHubOwnerRepo, parseGitHubRemoteIdentity } from './github-remote-identity-parsing'
import { applyGhHostToArgs } from '../git/runner'

// The resolved host rides on the gh exec options; replay the real runner
// helper so this still asserts the argv gh would actually receive.
function ghApiArgv(): string[][] {
  return ghExecFileAsyncMock.mock.calls
    .map(([args, options]) =>
      applyGhHostToArgs(args as string[], (options as { host?: string } | undefined)?.host)
    )
    .filter((args) => args[0] === 'api')
}

describe('issue #8935 GHE PR diff host routing', () => {
  beforeEach(() => {
    // Origin-repo resolution is cached module-side; a slug from one case must not leak into the next.
    _resetOriginGitHubApiRepositoryCache()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugForRemoteMock.mockReset()
    getEnterpriseGitHubRepoSlugForRemoteMock.mockResolvedValue(null)
    isGitHubHostAuthenticatedMock.mockReset()
    isGitHubHostAuthenticatedMock.mockResolvedValue(true)
    getWorkItemMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCommentsMock.mockReset()
    repositoryRateLimitGuardMock.mockReset()
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRepositoryRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('parseGitHubOwnerRepo returns null for Enterprise remotes (github.com only)', () => {
    expect(parseGitHubOwnerRepo('https://github.acme-corp.com/team/orca.git')).toBeNull()
    expect(parseGitHubOwnerRepo('git@github.acme-corp.com:team/orca.git')).toBeNull()
    expect(parseGitHubOwnerRepo('https://ghe.acme.internal/acme/widgets.git')).toBeNull()

    // Identity parser still sees host+owner+repo — data is available via enterprise slug
    expect(parseGitHubRemoteIdentity('https://github.acme-corp.com/team/orca.git')).toEqual({
      host: 'github.acme-corp.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('loads PR files and contents via enterprise host when getOwnerRepo is null', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:7',
      type: 'pr',
      number: 7,
      title: 'Enterprise PR',
      state: 'open',
      url: 'https://github.acme-corp.com/team/orca/pull/7',
      labels: [],
      updatedAt: '2026-07-16T00:00:00Z',
      author: 'pr-author'
    })
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/team/orca/pulls/7') {
        return {
          stdout: JSON.stringify({
            body: 'Enterprise PR body',
            head: { sha: 'head-sha' },
            base: { sha: 'base-sha' }
          })
        }
      }
      if (endpoint === 'repos/team/orca/pulls/7/files?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              filename: 'src/main.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -1 +1 @@'
            }
          ])
        }
      }
      if (endpoint.includes('contents/src/main.ts?ref=base-sha')) {
        return { stdout: 'old' }
      }
      if (endpoint.includes('contents/src/main.ts?ref=head-sha')) {
        return { stdout: 'new' }
      }
      return { stdout: JSON.stringify({ data: {} }) }
    })

    const details = await getWorkItemDetails('/repo-root', 7, 'pr')
    expect(details?.filesUnavailable).toBe(false)
    expect(details?.files?.map((f) => f.path)).toEqual(['src/main.ts'])

    const contents = await getPRFileContents({
      repoPath: '/repo-root',
      prNumber: 7,
      path: 'src/main.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })
    expect(contents).toMatchObject({ original: 'old', modified: 'new' })

    const apiCalls = ghApiArgv()
    expect(apiCalls.length).toBeGreaterThan(0)
    expect(apiCalls.every((args) => args.includes('--hostname'))).toBe(true)
    expect(
      apiCalls.every((args) => args[args.indexOf('--hostname') + 1] === 'github.acme-corp.com')
    ).toBe(true)
  })

  it('returns empty PR file contents when owner/repo cannot be resolved on any host', async () => {
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)

    const contents = await getPRFileContents({
      repoPath: '/repo-root',
      prNumber: 7,
      path: 'src/main.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })

    expect(contents).toEqual({
      original: '',
      modified: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('encodes # and ? in content paths while preserving directory separators', async () => {
    getOwnerRepoForRemoteMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue({
      owner: 'team',
      repo: 'orca',
      host: 'ghe.example.com'
    })
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint === 'repos/team/orca/contents/dir/a%23b%3Fc.ts?ref=base-sha') {
        return { stdout: 'base' }
      }
      if (endpoint === 'repos/team/orca/contents/dir/a%23b%3Fc.ts?ref=head-sha') {
        return { stdout: 'head' }
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    })

    const contents = await getPRFileContents({
      repoPath: '/repo-root',
      prNumber: 7,
      path: 'dir/a#b?c.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })

    expect(contents).toMatchObject({ original: 'base', modified: 'head' })
  })
})
