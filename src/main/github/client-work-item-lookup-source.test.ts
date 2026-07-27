import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GhUtils from './gh-utils'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  resolveIssueSourceMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  resolvePRRepositoryCandidatesMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    execFileAsync: execFileAsyncMock,
    ghExecFileAsync: ghExecFileAsyncMock,
    getOwnerRepo: getOwnerRepoMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock,
    _resetOwnerRepoCache: vi.fn()
  }
})

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: () => true
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  return {
    ...actual,
    // Why: these suites drive source resolution through the legacy gh-utils
    // mocks; bridge the hosted seams onto the same mocks.
    resolveIssueGitHubApiRepositorySource: (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolveIssueSourceMock(repoPath, preference, connectionId, localGitOptions),
    getIssueGitHubApiRepository: (repoPath: string, connectionId?: string | null) =>
      getIssueOwnerRepoMock(repoPath, connectionId),
    getOriginGitHubApiRepository: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => getOwnerRepoMock(repoPath, connectionId, localGitOptions),
    getGitHubApiRepositoryForRemote: (
      repoPath: string,
      remoteName: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) =>
      remoteName === 'origin'
        ? getOwnerRepoMock(repoPath, connectionId, localGitOptions)
        : getOwnerRepoForRemoteMock(repoPath, remoteName, connectionId, localGitOptions),
    resolveGitHubApiRepositoryCandidates: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolvePRRepositoryCandidatesMock(repoPath, connectionId, localGitOptions)
  }
})

import { getWorkItem, _resetOwnerRepoCache } from './client'

// Route resolvePrWorkItemSource's per-remote probes: origin delegates to
// getOwnerRepoMock (so existing tests keep defining origin through it) and
// upstream returns the given candidate.
function mockUpstreamCandidate(upstream: { owner: string; repo: string } | null): void {
  getOwnerRepoForRemoteMock.mockImplementation(
    async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
      remoteName === 'upstream' ? upstream : getOwnerRepoMock(repoPath, connectionId, opts)
  )
}

describe('GitHub work-item lookup source', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    resolvePRRepositoryCandidatesMock.mockReset()
    resolveIssueSourceMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    // Why: default the preference-aware resolver to 'auto' semantics so the
    // pre-existing test cases (which don't think about preference at all)
    // still pass. `listWorkItems` now calls `resolveIssueSource` instead of
    // `getIssueOwnerRepo` directly — we delegate back to the single-call
    // mock to preserve the one-fetch-per-test invariant each test sets up.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
    // Why: keep origin on the legacy mock while hosted candidate tests opt in
    // to upstream behavior explicitly.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
      const origin = await getOwnerRepoMock(repoPath, connectionId)
      const repository = origin ? { host: 'github.com', ...origin } : null
      return { candidates: repository ? [repository] : [], headRepo: repository }
    })
    _resetOwnerRepoCache()
  })

  it('typed PR lookup does not fetch an upstream issue with the same number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        html_url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updated_at: '2026-04-02T00:00:00Z',
        user: { login: 'octocat' },
        draft: false,
        head: { ref: 'feature' },
        base: { ref: 'main' }
      })
    })

    const item = await getWorkItem('/repo-root', 42, 'pr')

    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '42',
        '--repo',
        'fork/orca',
        '--json',
        expect.stringContaining('reviewDecision')
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(item?.type).toBe('pr')
  })

  it('probes the upstream repository for a typed fork PR before origin', async () => {
    const upstream = { owner: 'stablyai', repo: 'orca', host: 'github.com' }
    const origin = { owner: 'fork', repo: 'orca', host: 'github.com' }
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [upstream, origin],
      headRepo: origin
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Upstream PR',
        state: 'open',
        url: 'https://github.com/stablyai/orca/pull/42',
        labels: [],
        updatedAt: '2026-04-02T00:00:00Z',
        author: { login: 'octocat' },
        isDraft: false
      })
    })

    const item = await getWorkItem('/repo-root', 42, 'pr')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '42',
        '--repo',
        'stablyai/orca',
        '--json',
        expect.stringContaining('reviewDecision')
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(item?.prRepo).toEqual(upstream)
  })

  it('pins typed PR metadata to explicit origin when upstream has the same number', async () => {
    const upstream = { owner: 'stablyai', repo: 'orca', host: 'github.com' }
    const origin = { owner: 'fork', repo: 'orca', host: 'github.com' }
    getOwnerRepoMock.mockResolvedValue(origin)
    mockUpstreamCandidate(upstream)
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [upstream, origin],
      headRepo: origin
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updatedAt: '2026-04-02T00:00:00Z',
        author: { login: 'octocat' },
        isDraft: false,
        headRefName: 'origin/fix',
        baseRefName: 'main'
      })
    })

    const item = await getWorkItem('/repo-root', 42, 'pr', null, {}, 'origin')

    expect(resolvePRRepositoryCandidatesMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['pr', 'view', '--repo', 'fork/orca'])
    )
    expect(
      ghExecFileAsyncMock.mock.calls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('upstream/orca'))
      )
    ).toBe(false)
    expect(item?.prRepo).toEqual(origin)
  })

  it('does not run a bare PR lookup when explicit origin identity is unresolved', async () => {
    getOwnerRepoMock.mockResolvedValue(null)
    mockUpstreamCandidate({ owner: 'stablyai', repo: 'orca' })

    await expect(getWorkItem('/repo-root', 42, 'pr', null, {}, 'origin')).resolves.toBeNull()

    expect(resolvePRRepositoryCandidatesMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not run a bare gh lookup for an SSH repo without candidates', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({ candidates: [], headRepo: null })

    await expect(getWorkItem('/remote/repo', 42, 'pr', 'ssh-1')).resolves.toBeNull()

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not probe a second PR repository after a non-not-found failure', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        { owner: 'fork', repo: 'orca', host: 'github.com' }
      ],
      headRepo: { owner: 'fork', repo: 'orca', host: 'github.com' }
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 500: server error'))
      .mockRejectedValueOnce(new Error('HTTP 500: server error'))

    await expect(getWorkItem('/repo-root', 42, 'pr')).resolves.toBeNull()

    // The first candidate uses `pr view` and its REST compatibility fallback;
    // neither failure is a 404, so a same-number PR on origin is never queried.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(
      ghExecFileAsyncMock.mock.calls.some(([args]) =>
        (args as string[]).some((arg) => arg.includes('fork/orca'))
      )
    ).toBe(false)
  })

  it('raw number lookup tries upstream issue before origin PR', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    // Why: simulate a real gh 404 (the only error type that should fall through).
    // Non-404 errors re-throw so transient upstream failures don't misroute to an
    // unrelated origin PR with the same number.
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        html_url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updated_at: '2026-04-02T00:00:00Z',
        user: { login: 'octocat' },
        draft: false
      })
    })

    const item = await getWorkItem('/repo-root', 42)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/stablyai/orca/issues/42'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'view',
        '42',
        '--repo',
        'fork/orca',
        '--json',
        expect.stringContaining('reviewDecision')
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(item?.type).toBe('pr')
  })

  it('raw number lookup does not fall through on transient upstream errors', async () => {
    // Why: with issue source split, a non-404 upstream failure must not silently
    // route to origin's PR #N — that would return an unrelated item.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 500: server error'))

    const item = await getWorkItem('/repo-root', 42)

    expect(item).toBeNull()
    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
