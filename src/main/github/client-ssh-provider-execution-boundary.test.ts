/*
 * #14945 — SSH git execution boundary.
 *
 * getCurrentHeadOid, probeTrackedUpstreamBranches, and the default-branch
 * resolver all route through the SSH provider only when one is registered. With
 * connectionId set but the provider unregistered (dropped connection, not yet
 * reattached) the old code fell through to client-side git with cwd pointing at
 * the remote repoPath — on a machine with a same-named local path that silently
 * answers for the WRONG repository. getCurrentHeadOid feeds
 * shouldHideMergedImplicitPR, so a wrong OID changes which PR the UI attributes
 * to a worktree.
 *
 * The boundary is strict: for an SSH-hosted repoPath, an unregistered (or
 * mid-flight-lost) provider means "we could not ask" — it must never degrade
 * into a client-side git run. HEAD/tracked-upstream stay UNVERIFIABLE (the
 * lookup reports upstream-error and preserves PR state); the default-branch
 * resolver takes its existing unknown (null) path so the stale-PR guard fails
 * open. These probes are reached through the real getPRForBranchOutcome
 * dispatcher, not a hand-built double.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  getRemoteUrlForRepoMock,
  gitExecFileAsyncMock,
  getRateLimitMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  ghRepoExecOptionsMock,
  githubRepoContextMock,
  getSshGitProviderMock,
  readLocalGitConfigSignatureMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  resolvePRRepositoryCandidatesMock: vi.fn(),
  getRemoteUrlForRepoMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getRateLimitMock: vi.fn(),
  rateLimitGuardMock: vi.fn<(bucket?: string) => RateLimitGuardResult>(() => ({
    blocked: false
  })),
  noteRateLimitSpendMock: vi.fn(),
  ghRepoExecOptionsMock: vi.fn((context) =>
    context.connectionId
      ? {}
      : {
          cwd: context.repoPath,
          ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
        }
  ),
  githubRepoContextMock: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  getSshGitProviderMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidates: resolvePRRepositoryCandidatesMock,
  getRemoteUrlForRepo: getRemoteUrlForRepoMock,
  gitExecFileAsync: gitExecFileAsyncMock,
  ghRepoExecOptions: ghRepoExecOptionsMock,
  githubRepoContext: githubRepoContextMock,
  classifyGhError: (stderr: string) => {
    const lower = stderr.toLowerCase()
    if (lower.includes('not found') || stderr.includes('HTTP 404')) {
      return { type: 'not_found', message: stderr }
    }
    if (lower.includes('rate limit')) {
      return { type: 'rate_limited', message: stderr }
    }
    return { type: 'unknown', message: stderr }
  },
  parseGitHubOwnerRepo: (remoteUrl: string) => {
    const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
    return match ? { owner: match[1], repo: match[2] } : null
  },
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import {
  getPRForBranch,
  getPRForBranchOutcome,
  _resetOwnerRepoCache,
  _resetMergeQueueCacheForTests,
  __resetTrackedUpstreamBranchCacheForTests
} from './client'
import { __resetPRConflictSummaryCachesForTests } from './conflict-summary'
import { resetMergedPRCommitMembershipCacheForTest } from './merged-pr-commit-membership'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

const SSH_CONNECTION = 'ssh-1'
const REMOTE_REPO = '/remote/repo'
const MERGED_BRANCH = 'feature-merged'
const MERGED_HEAD_OID = 'merged-head-oid'

type RestPRShape = {
  number?: number
  state?: string
  merged_at?: string | null
  head_ref?: string
  head_sha?: string
}

function restPR({
  number = 5875,
  state = 'closed',
  merged_at = null,
  head_ref = MERGED_BRANCH,
  head_sha = MERGED_HEAD_OID
}: RestPRShape = {}): Record<string, unknown> {
  return {
    number,
    title: 'Boundary PR',
    state,
    merged_at,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    updated_at: '2026-06-20T04:53:05Z',
    draft: false,
    mergeable: null,
    base: { ref: 'main', sha: 'base-oid' },
    head: { ref: head_ref, sha: head_sha }
  }
}

/** Route only the REST head-branch lookup; every other gh call fails so the
 *  branch payload is kept as-is (hydration falls back to it). */
function primeGhExecWithBranchList(list: Record<string, unknown>[]): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'api' && args[1]?.includes('pulls?head=')) {
      return { stdout: JSON.stringify(list) }
    }
    throw new Error(`gh unavailable: ${args.join(' ')}`)
  })
}

/** A merged implicit PR on MERGED_BRANCH — drives the getCurrentHeadOid probe. */
function primeMergedImplicitPR(): void {
  primeGhExecWithBranchList([restPR({ state: 'closed', merged_at: '2026-06-20T04:53:05Z' })])
}

/** No branch PR — drives the tracked-upstream `for-each-ref` probe. */
function primeNoBranchPR(): void {
  primeGhExecWithBranchList([])
}

describe('getPRForBranch SSH execution boundary (#14945)', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    resolvePRRepositoryCandidatesMock.mockReset()
    resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
      const origin = await getOwnerRepoMock(repoPath, connectionId)
      return { candidates: origin ? [origin] : [], headRepo: origin }
    })
    getRemoteUrlForRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    getRateLimitMock.mockReset()
    getRateLimitMock.mockResolvedValue({ resources: {} })
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    ghRepoExecOptionsMock.mockClear()
    githubRepoContextMock.mockClear()
    getSshGitProviderMock.mockReset()
    readLocalGitConfigSignatureMock.mockReset()
    readLocalGitConfigSignatureMock.mockResolvedValue(undefined)
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
    _resetMergeQueueCacheForTests()
    __resetTrackedUpstreamBranchCacheForTests()
    __resetPRConflictSummaryCachesForTests()
    resetMergedPRCommitMembershipCacheForTest()
    __resetRepoDefaultBranchCacheForTests()
  })

  it('does not rev-parse HEAD locally when the SSH provider is unregistered', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    primeMergedImplicitPR()
    // A same-named local path would answer here; the boundary must not consult it.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${MERGED_HEAD_OID}\n`, stderr: '' })

    const outcome = await getPRForBranchOutcome(REMOTE_REPO, MERGED_BRANCH, null, SSH_CONNECTION)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error' })
  })

  it('reports an upstream error when the SSH HEAD probe loses its provider mid-flight', async () => {
    getSshGitProviderMock.mockReturnValue({
      exec: vi.fn().mockRejectedValue(new Error('SSH transport closed'))
    })
    primeMergedImplicitPR()

    const outcome = await getPRForBranchOutcome(REMOTE_REPO, MERGED_BRANCH, null, SSH_CONNECTION)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error' })
  })

  it('rev-parses HEAD through the SSH provider when it is registered', async () => {
    const sshGitProvider = {
      exec: vi.fn(async (args: string[]) =>
        args[0] === 'rev-parse' && args[1] === 'HEAD'
          ? { stdout: `${MERGED_HEAD_OID}\n`, stderr: '' }
          : { stdout: '', stderr: '' }
      )
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    primeMergedImplicitPR()

    const pr = await getPRForBranch(REMOTE_REPO, MERGED_BRANCH, null, SSH_CONNECTION)

    expect(sshGitProvider.exec).toHaveBeenCalledWith(['rev-parse', 'HEAD'], REMOTE_REPO)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    // Worktree HEAD is the merged PR's own head → merged-at-head carve-out keeps it.
    expect(pr).toMatchObject({ number: 5875, state: 'merged' })
  })

  it('rev-parses HEAD through the local runtime for a WSL repository', async () => {
    primeMergedImplicitPR()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: `${MERGED_HEAD_OID}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const pr = await getPRForBranch(REMOTE_REPO, MERGED_BRANCH, null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rev-parse', 'HEAD'], {
      cwd: REMOTE_REPO,
      wslDistro: 'Ubuntu'
    })
    expect(pr).toMatchObject({ number: 5875, state: 'merged' })
  })

  it('does not read tracked upstreams locally when the SSH provider is unregistered', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    primeNoBranchPR()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: `${MERGED_BRANCH}\0origin/contributor/original\n`,
      stderr: ''
    })

    const outcome = await getPRForBranchOutcome(REMOTE_REPO, MERGED_BRANCH, null, SSH_CONNECTION)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error' })
    // The branch lookup still ran; only the local git fall-through is refused.
    expect(ghExecFileAsyncMock).toHaveBeenCalled()
  })

  it('reports an upstream error when the SSH upstream probe loses its provider mid-flight', async () => {
    getSshGitProviderMock.mockReturnValue({
      exec: vi.fn().mockRejectedValue(new Error('SSH transport closed'))
    })
    primeNoBranchPR()

    const outcome = await getPRForBranchOutcome(REMOTE_REPO, MERGED_BRANCH, null, SSH_CONNECTION)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error' })
  })

  it('does not resolve the default branch locally when the SSH provider is unregistered', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    // A closed implicit PR on the checked-out branch: the stale-closed guard
    // resolves the default branch. A local run against the remote repoPath here
    // could report the branch AS the default and wrongly hide a real PR.
    primeGhExecWithBranchList([restPR({ number: 42, state: 'closed', head_ref: 'master' })])
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
        return { stdout: 'refs/remotes/origin/master\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'default-branch-oid\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const outcome = await getPRForBranchOutcome(REMOTE_REPO, 'master', null, SSH_CONNECTION)

    // Default branch stays unknown → the guard fails open and keeps the PR,
    // and no client-side git ran against the remote repoPath.
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'found' })
  })
})
