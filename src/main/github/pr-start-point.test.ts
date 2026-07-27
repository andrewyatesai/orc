import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPullRequestPushTargetMock, getWorkItemMock } = vi.hoisted(() => ({
  getPullRequestPushTargetMock: vi.fn(),
  getWorkItemMock: vi.fn()
}))

vi.mock('./client', () => ({
  getPullRequestPushTarget: getPullRequestPushTargetMock,
  getWorkItem: getWorkItemMock
}))

import { resolveGitHubPrStartPoint } from './pr-start-point'
import { reviewHeadRemoteRefComponent } from '../../shared/review-head-tracking-ref'

const ORIGIN_URL = 'git@github.com:acme/orca.git'
const ORIGIN_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_URL)
const durablePrLocalRef = (prNumber: number): string =>
  `refs/orca/pull/${ORIGIN_COMPONENT}/${prNumber}`
const durablePrRev = (prNumber: number): string => `${durablePrLocalRef(prNumber)}^{commit}`
const remoteGetUrl = (args: string[]): { stdout: string; stderr: string } | null =>
  args[0] === 'remote' && args[1] === 'get-url' ? { stdout: `${ORIGIN_URL}\n`, stderr: '' } : null

describe('resolveGitHubPrStartPoint', () => {
  const fetchPullRequestHeadRefMock = vi.fn()

  beforeEach(() => {
    getPullRequestPushTargetMock.mockReset()
    getWorkItemMock.mockReset()
    fetchPullRequestHeadRefMock.mockReset()
    // Why: success path rev-parses the path the fetch returns (writer-authoritative).
    fetchPullRequestHeadRefMock.mockImplementation(async (_remote: string, prNumber: number) =>
      durablePrLocalRef(prNumber)
    )
  })

  it('falls back to the GitHub PR head ref when a direct branch fetch fails', async () => {
    getPullRequestPushTargetMock.mockResolvedValue({
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'fix-issue-6933',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
    const fetchRemoteTrackingRef = vi.fn(async (_remote: string, branch: string) => {
      if (branch === 'fix-issue-6933') {
        throw new Error('fatal: could not find remote ref')
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 6934,
      headRefName: 'fix-issue-6933',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'fix-issue-6933')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'main')
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 6934)
    expect(result).toEqual({
      baseBranch: 'def456',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'def456',
      branchNameOverride: 'fix-issue-6933',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'fix-issue-6933',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
  })

  it('keeps the PR head ref fallback when push-target discovery also fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref')
    })
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith(
      '/repo-root',
      1849,
      null,
      {},
      undefined
    )
    expect(result).toEqual({
      baseBranch: 'def456',
      headSha: 'def456',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('resolves an inaccessible fork PR even when push-target discovery fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith(
      '/repo-root',
      1849,
      null,
      {},
      undefined
    )
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 1849)
    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('prefers the pull-head error when the branch miss triggered a failing fallback', async () => {
    // Why: the branch fetch missed and we fell back to refs/pull/<N>/head; the
    // fallback failure is the actionable one, not the original branch miss.
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref refs/heads/feature/fix')
    })
    fetchPullRequestHeadRefMock.mockRejectedValue(
      new Error(
        'This SSH host is running an older Orca relay that cannot fetch pull request heads.'
      )
    )
    const gitExec = vi.fn(async () => ({ stdout: '', stderr: '' }))

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 77,
      headRefName: 'feature/fix',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(result).toEqual({
      error:
        'Failed to fetch refs/pull/77/head: This SSH host is running an older Orca relay that cannot fetch pull request heads.'
    })
  })

  it('captures the fork PR head from a dedicated ref, not the shared FETCH_HEAD', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    // Why: simulate a concurrent `git fetch origin` clobbering FETCH_HEAD with the
    // default-branch tip. The resolved start-point must come from the durable Orca ref.
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)
        if (ref === 'FETCH_HEAD') {
          return { stdout: 'mainbranchtip000\n', stderr: '' }
        }
        if (ref === durablePrRev(1849)) {
          return { stdout: 'prheadsha111\n', stderr: '' }
        }
        throw new Error(`unexpected rev-parse ref: ${ref}`)
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 1849)
    // Success path must not re-hash remote identity after the fetch returns a path.
    expect(gitExec).not.toHaveBeenCalledWith(['remote', 'get-url', 'origin'])
    expect(gitExec).not.toHaveBeenCalledWith(['rev-parse', '--verify', 'FETCH_HEAD'])
    expect(result).toEqual({
      baseBranch: 'prheadsha111',
      headSha: 'prheadsha111',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('keeps the durable PR head when the head fetch fails but the local ref resolves', async () => {
    // Why: mirror compare-base soft-keep — a transient fetch failure must not
    // fail the resolve when a prior fetch already pinned refs/orca/pull/<N>.
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    fetchPullRequestHeadRefMock.mockRejectedValue(
      new Error('fatal: unable to access repo: Could not resolve host: github.com')
    )
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse' && args[2] === durablePrRev(1849)) {
        return { stdout: 'pinnedheadsha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'base-commit-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await resolveGitHubPrStartPoint({
        repoPath: '/repo-root',
        prNumber: 1849,
        headRefName: 'contributor/fix',
        baseRefName: 'main',
        isCrossRepository: true,
        gitExec,
        fetchRemoteTrackingRef,
        fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
        resolveRemote: async () => 'origin',
        resolveRemoteAlternatives: async () => []
      })

      expect(result).toEqual({
        baseBranch: 'pinnedheadsha',
        compareBaseRef: 'refs/remotes/origin/main',
        headSha: 'pinnedheadsha',
        branchNameOverride: 'contributor/fix'
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it.each([
    // Why: a missing ref is the one case that walks remotes first, so it lands on
    // the multi-remote exhaustion message rather than the verbatim git error.
    {
      case: 'deleted PR / cleaned fork',
      message: "fatal: couldn't find remote ref refs/pull/1849/head",
      expectedError: 'Failed to fetch refs/pull/1849/head from any configured remote (origin).'
    },
    {
      case: 'auth failure',
      message: 'Authentication failed. Check your remote credentials.',
      expectedError:
        'Failed to fetch refs/pull/1849/head: Authentication failed. Check your remote credentials.'
    },
    {
      case: 'stale relay',
      message:
        'This SSH host is running an older Orca relay that cannot fetch pull request heads. Reconnect to deploy the latest relay, then try again.',
      expectedError:
        'Failed to fetch refs/pull/1849/head: This SSH host is running an older Orca relay that cannot fetch pull request heads. Reconnect to deploy the latest relay, then try again.'
    }
  ])(
    'fails hard instead of soft-keeping the durable PR head on: $case',
    async ({ message, expectedError }) => {
      // Why: soft-keep on a non-transient failure would check out a dead or
      // unauthorized tip (or mask the reconnect prompt) with a success UX.
      getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
      fetchPullRequestHeadRefMock.mockRejectedValue(new Error(message))
      const fetchRemoteTrackingRef = vi.fn(async () => {})
      const gitExec = vi.fn(async (args: string[]) => {
        const url = remoteGetUrl(args)
        if (url) {
          return url
        }
        if (args[0] === 'rev-parse' && args[2] === durablePrRev(1849)) {
          return { stdout: 'pinnedheadsha\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      })

      const result = await resolveGitHubPrStartPoint({
        repoPath: '/repo-root',
        prNumber: 1849,
        headRefName: 'contributor/fix',
        baseRefName: 'main',
        isCrossRepository: true,
        gitExec,
        fetchRemoteTrackingRef,
        fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
        resolveRemote: async () => 'origin',
        resolveRemoteAlternatives: async () => []
      })

      expect(result).toEqual({ error: expectedError })
      expect(gitExec).not.toHaveBeenCalledWith(['rev-parse', '--verify', durablePrRev(1849)])
    }
  )

  it('soft-keeps the durable PR head on an exec-timeout kill', async () => {
    getPullRequestPushTargetMock.mockRejectedValue(new Error('head repo is unavailable'))
    const timeoutError = Object.assign(new Error('Command failed: git fetch --no-tags origin'), {
      killed: true,
      signal: 'SIGTERM'
    })
    fetchPullRequestHeadRefMock.mockRejectedValue(timeoutError)
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse' && args[2] === durablePrRev(1849)) {
        return { stdout: 'pinnedheadsha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await resolveGitHubPrStartPoint({
        repoPath: '/repo-root',
        prNumber: 1849,
        headRefName: 'contributor/fix',
        isCrossRepository: true,
        gitExec,
        fetchRemoteTrackingRef,
        fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
        resolveRemote: async () => 'origin',
        resolveRemoteAlternatives: async () => []
      })

      expect(result).toEqual({
        baseBranch: 'pinnedheadsha',
        headSha: 'pinnedheadsha',
        branchNameOverride: 'contributor/fix'
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('uses PR metadata when the caller did not pass a head ref', async () => {
    getWorkItemMock.mockResolvedValue({
      type: 'pr',
      branchName: 'contributor/fix',
      baseRefName: 'main',
      isCrossRepository: true
    })
    getPullRequestPushTargetMock.mockResolvedValue({
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1738,
      issueSourcePreference: 'origin',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 1738, 'pr', null, {}, 'origin')
    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith(
      '/repo-root',
      1738,
      null,
      {},
      'origin'
    )
    expect(result).toEqual({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'abc123',
      branchNameOverride: 'contributor/fix',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })
  })

  it('surfaces maintainerCanModify=false for a fork PR so the caller can warn', async () => {
    getPullRequestPushTargetMock.mockResolvedValue({
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      },
      maintainerCanModify: false
    })
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 1849,
      headRefName: 'contributor/fix',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'contributor/fix',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'git@github.com:contributor/orca.git'
      },
      maintainerCanModify: false
    })
  })

  it('returns the verified head SHA, branch override, and push target when same-repo branch fetch succeeds', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const gitExec = vi.fn(async (args: string[]) => {
      const url = remoteGetUrl(args)
      if (url) {
        return url
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'feature/add-feature',
      baseRefName: 'develop',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'origin',
      resolveRemoteAlternatives: async () => []
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'feature/add-feature')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'develop')
    expect(gitExec).toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/feature/add-feature'])
    expect(result).toEqual({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/develop',
      headSha: 'abc123',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })

  // Why: covers the multi-remote bug where the alphabetic-first remote (e.g.
  // `yzc`) lacks the PR branch, so the resolver must walk `origin` next.
  it('falls back to an alternate remote when the primary returns missing-ref', async () => {
    const fetchRemoteTrackingRef = vi.fn(async (remote: string, branch: string) => {
      if (remote === 'yzc' && branch === 'fix/qweather-agent-tool-port') {
        throw new Error('fatal: could not find remote ref fix/qweather-agent-tool-port')
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'origin/fix/qweather-agent-tool-port'
      ) {
        return { stdout: 'deadbeef\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 4711,
      headRefName: 'fix/qweather-agent-tool-port',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin']
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('yzc', 'fix/qweather-agent-tool-port')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'fix/qweather-agent-tool-port')
    expect(gitExec).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      'origin/fix/qweather-agent-tool-port'
    ])
    expect(result).toEqual({
      baseBranch: 'deadbeef',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'deadbeef',
      branchNameOverride: 'fix/qweather-agent-tool-port',
      pushTarget: { remoteName: 'origin', branchName: 'fix/qweather-agent-tool-port' }
    })
  })

  // Why: reproduces the exact bug-report failure. The git runner rejects with
  // `.message = "Command failed: git fetch yzc …"` (no missing-ref text) and
  // stashes git's `fatal: couldn't find remote ref …` in `.stderr`. The
  // resolver must read `.stderr` to recognize the missing ref and walk to
  // `origin`, otherwise it would surface the bogus `Failed to fetch yzc/…`.
  it('falls back to an alternate remote when the primary error hides the missing ref in .stderr', async () => {
    const fetchRemoteTrackingRef = vi.fn(async (remote: string, branch: string) => {
      if (remote === 'yzc' && branch === 'fix/qweather-agent-tool-port') {
        throw Object.assign(
          new Error(
            'Command failed: git fetch yzc +refs/heads/fix/qweather-agent-tool-port:refs/remotes/yzc/fix/qweather-agent-tool-port'
          ),
          { stderr: "fatal: couldn't find remote ref refs/heads/fix/qweather-agent-tool-port" }
        )
      }
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'origin/fix/qweather-agent-tool-port'
      ) {
        return { stdout: 'deadbeef\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 4711,
      headRefName: 'fix/qweather-agent-tool-port',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin']
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('yzc', 'fix/qweather-agent-tool-port')
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'fix/qweather-agent-tool-port')
    expect(result).toEqual({
      baseBranch: 'deadbeef',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'deadbeef',
      branchNameOverride: 'fix/qweather-agent-tool-port',
      pushTarget: { remoteName: 'origin', branchName: 'fix/qweather-agent-tool-port' }
    })
  })

  // Why: surfaces the original bug report's error message when every configured
  // remote is missing the branch. The user-visible message used to read
  // `Failed to fetch <primary>/<branch>` even when an alternate remote could
  // have served the ref.
  it('reports the configured remotes when none can resolve the head branch', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref')
    })
    fetchPullRequestHeadRefMock.mockRejectedValue(
      new Error('fatal: could not find remote ref refs/pull/42/head')
    )
    const gitExec = vi.fn(async (args: string[]) => {
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'feature/missing',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin', 'backup']
    })

    expect(result).toEqual({
      error:
        'Failed to fetch feature/missing (or refs/pull/42/head) from any configured remote (yzc, origin, backup).'
    })
    // Why: the refs/pull/<N>/head fallback must also probe alternatives before
    // returning an error — here every remote rejects the same way, so the
    // iteration visits each candidate before bubbling up the unified error.
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('yzc', 42)
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 42)
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('backup', 42)
  })

  // Why: the durable-ref fetch is per-remote too — a primary that lacks
  // refs/pull/<N>/head must not stop the walk before an alternate serves it.
  it('walks to an alternate remote for the durable PR head ref', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref')
    })
    fetchPullRequestHeadRefMock.mockImplementation(async (remote: string, prNumber: number) => {
      if (remote !== 'origin') {
        throw new Error(`fatal: couldn't find remote ref refs/pull/${prNumber}/head`)
      }
      return durablePrLocalRef(prNumber)
    })
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[2] === durablePrRev(42)) {
        return { stdout: 'prheadsha42\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'feature/missing',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin']
    })

    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('yzc', 42)
    expect(fetchPullRequestHeadRefMock).toHaveBeenCalledWith('origin', 42)
    expect(result).toEqual({
      baseBranch: 'prheadsha42',
      headSha: 'prheadsha42',
      branchNameOverride: 'feature/missing'
    })
  })

  // Why: a non-missing-ref failure (auth/network/SSH) on the refs/pull fallback
  // must surface verbatim, not be masked by the generic "not found anywhere"
  // message. Otherwise an SSH/auth problem looks like a missing ref.
  it('surfaces a hard refs/pull error instead of a not-found message (same-repo fallback)', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {
      throw new Error('fatal: could not find remote ref')
    })
    fetchPullRequestHeadRefMock.mockRejectedValue(new Error('Permission denied (publickey)'))
    const gitExec = vi.fn(async (args: string[]) => {
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'feature/missing',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin', 'backup']
    })

    expect(result).toEqual({
      error: 'Failed to fetch refs/pull/42/head: Permission denied (publickey)'
    })
  })

  // Why: the cross-repo path must also surface a hard refs/pull error verbatim
  // rather than the plain not-found message.
  it('surfaces a hard refs/pull error instead of a not-found message (cross-repo)', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    fetchPullRequestHeadRefMock.mockRejectedValue(new Error('Permission denied (publickey)'))
    const gitExec = vi.fn(async (args: string[]) => {
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitHubPrStartPoint({
      repoPath: '/repo-root',
      prNumber: 42,
      headRefName: 'feature/missing',
      baseRefName: 'main',
      isCrossRepository: true,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef: fetchPullRequestHeadRefMock,
      resolveRemote: async () => 'yzc',
      resolveRemoteAlternatives: async () => ['origin', 'backup']
    })

    expect(result).toEqual({
      error: 'Failed to fetch refs/pull/42/head: Permission denied (publickey)'
    })
  })
})
