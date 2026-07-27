import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  getGiteaAuthStatus,
  getGiteaPullRequestForBranch,
  getGiteaPullRequestForBranchOrThrow,
  normalizeGiteaApiBaseUrl
} from './client'
import { _resetGiteaRepoRefCache } from './repository-ref'
import {
  _getGiteaPullRequestScanCacheSize,
  _resetGiteaPullRequestScanCache,
  scanGiteaPullRequests
} from './pull-request-scan-cache'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

const OLD_ENV = process.env

/** Serve the remote URL plus the #9171 default-branch resolver probes. */
function primeGitExecWithDefaultBranch(defaultRef = 'refs/remotes/origin/main'): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote') {
      return { stdout: 'https://git.example.com/team/repo.git\n', stderr: '' }
    }
    if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
      return { stdout: `${defaultRef}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args.includes(defaultRef)) {
      return { stdout: 'default-oid\n', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

function giteaPr(index = 7, branch = 'feature/gitea') {
  return {
    number: index,
    title: 'Add Gitea',
    state: 'open',
    html_url: `https://git.example.com/team/repo/pulls/${index}`,
    updated_at: '2026-05-15T00:00:00Z',
    mergeable: true,
    head: {
      ref: branch,
      label: `team:${branch}`,
      sha: 'abc123'
    }
  }
}

describe('Gitea client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    delete process.env.ORCA_GITEA_API_BASE_URL
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://git.example.com/team/repo.git\n',
      stderr: ''
    })
    _resetGiteaRepoRefCache()
    _resetGiteaPullRequestScanCache()
    __resetRepoDefaultBranchCacheForTests()
    vi.unstubAllGlobals()
  })

  it('hides a stale closed PR whose source branch is the repo default branch (#9171)', async () => {
    primeGitExecWithDefaultBranch()
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([{ ...giteaPr(7, 'main'), state: 'closed' }])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'refs/heads/main')).resolves.toBeNull()
  })

  it('hides a stale merged PR on the default branch but keeps an open one', async () => {
    primeGitExecWithDefaultBranch()
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([{ ...giteaPr(9, 'main'), merged: true }])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'refs/heads/main')).resolves.toBeNull()

    _resetGiteaPullRequestScanCache()
    __resetRepoDefaultBranchCacheForTests()
    const openFetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([giteaPr(10, 'main')])
    })
    vi.stubGlobal('fetch', openFetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'refs/heads/main')).resolves.toMatchObject({
      number: 10,
      state: 'open'
    })
  })

  it('discards a closed default-branch shadow and refetches the linked PR via the fallback (#9171)', async () => {
    primeGitExecWithDefaultBranch()
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (parsed.pathname.endsWith('/pulls/42')) {
        return Response.json(giteaPr(42, 'main'))
      }
      return Response.json([{ ...giteaPr(7, 'main'), state: 'closed' }])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGiteaPullRequestForBranch('/repo', 'refs/heads/main', 42)
    ).resolves.toMatchObject({ number: 42 })
  })

  it('normalizes Gitea API base URLs', () => {
    expect(normalizeGiteaApiBaseUrl('https://git.example.com')).toBe(
      'https://git.example.com/api/v1'
    )
    expect(normalizeGiteaApiBaseUrl('https://git.example.com/api/v1/')).toBe(
      'https://git.example.com/api/v1'
    )
  })

  it('fetches a branch pull request and commit status', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url)
      if (!init) {
        throw new Error('expected request init')
      }
      expect((init.headers as Record<string, string>).Authorization).toBe('token gitea-token')
      if (parsed.pathname.endsWith('/commits/abc123/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGiteaPullRequestForBranch('/repo', 'refs/heads/feature/gitea')
    ).resolves.toEqual({
      number: 7,
      title: 'Add Gitea',
      state: 'open',
      url: 'https://git.example.com/team/repo/pulls/7',
      status: 'success',
      updatedAt: '2026-05-15T00:00:00Z',
      mergeable: 'MERGEABLE',
      headSha: 'abc123'
    })

    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(listUrl.origin).toBe('https://git.example.com')
    expect(listUrl.pathname).toBe('/api/v1/repos/team/repo/pulls')
    expect(listUrl.searchParams.get('state')).toBe('all')
    expect(listUrl.searchParams.get('sort')).toBe('recentupdate')
    expect(listUrl.searchParams.get('page')).toBe('1')
    expect(listUrl.searchParams.get('limit')).toBe('50')
  })

  it('shares one /pulls scan across concurrent branch lookups (#8807)', async () => {
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      listCalls++
      return Response.json([giteaPr(7, 'feature/a'), giteaPr(8, 'feature/b')])
    })
    vi.stubGlobal('fetch', fetchMock)

    const [a, b, missing] = await Promise.all([
      getGiteaPullRequestForBranch('/repo', 'feature/a'),
      getGiteaPullRequestForBranch('/repo', 'feature/b'),
      getGiteaPullRequestForBranch('/repo', 'feature/none')
    ])

    expect(a?.number).toBe(7)
    expect(b?.number).toBe(8)
    expect(missing).toBeNull()
    expect(listCalls).toBe(1)
  })

  it('reuses the cached /pulls scan for lookups inside the TTL', async () => {
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      listCalls++
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
    await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
    await getGiteaPullRequestForBranch('/repo', 'no-pr-branch')

    expect(listCalls).toBe(1)
  })

  it('retries a failed /pulls scan after only the short failure cooldown', async () => {
    vi.useFakeTimers()
    try {
      let listCalls = 0
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url)
        if (parsed.pathname.endsWith('/status')) {
          return Response.json({ state: 'success' })
        }
        listCalls++
        return listCalls === 1
          ? Response.json({ message: 'temporary failure' }, { status: 503 })
          : Response.json([giteaPr()])
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
      expect(listCalls).toBe(1)

      await vi.advanceTimersByTimeAsync(3_001)
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
        number: 7
      })
      expect(listCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a lookup failure via getGiteaPullRequestForBranchOrThrow instead of null (finding 4)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'unauthorized' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    // The swallowing variant returns null — indistinguishable from "no PR".
    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
    // The throwing variant makes the failure visible so eligibility records
    // `unavailable` rather than a false "No pull request found".
    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')).rejects.toThrow(
      /Gitea request failed/
    )
  })

  it('never attaches the PAT to a cleartext http remote-derived host (SSRF / token exfil)', async () => {
    // Token set for the real instance, no configured base URL: the request host is
    // derived from the git remote, which an attacker (or a metadata literal) controls.
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'http://169.254.169.254/o/r.git\n',
      stderr: ''
    })
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([]))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/x')).resolves.toBeNull()

    expect(fetchMock).toHaveBeenCalled()
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBeUndefined()
  })

  it('never attaches the PAT to an https internal/metadata remote-derived host in token-only mode', async () => {
    // Token-only mode (no configured base URL): the request host is derived from
    // the untrusted git remote. Requiring https alone is not enough — a malicious
    // remote could still point at an internal/metadata literal over https and
    // exfiltrate the PAT. The token must never follow it to internal infra.
    for (const remote of [
      'https://169.254.169.254/o/r.git',
      'https://10.0.0.5/o/r.git',
      'https://192.168.1.10/o/r.git'
    ]) {
      gitExecFileAsyncMock.mockResolvedValue({ stdout: `${remote}\n`, stderr: '' })
      _resetGiteaRepoRefCache()
      _resetGiteaPullRequestScanCache()
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([]))
      vi.stubGlobal('fetch', fetchMock)

      await expect(getGiteaPullRequestForBranch('/repo', 'feature/x')).resolves.toBeNull()

      // The lookup still runs (anonymously); it just must not carry the PAT.
      expect(fetchMock).toHaveBeenCalled()
      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
      expect(headers?.Authorization).toBeUndefined()
    }
  })

  it('attaches the PAT to a loopback remote-derived host (SSH-tunnel / local instance)', async () => {
    // Loopback never leaves the machine, so a forwarded-port / local Gitea over http
    // (or ::1) is a trusted recipient — the fork's SSH-tunnel and local-dev flows.
    for (const remote of ['http://127.0.0.1:3000/o/r.git', 'https://[::1]/o/r.git']) {
      gitExecFileAsyncMock.mockResolvedValue({ stdout: `${remote}\n`, stderr: '' })
      _resetGiteaRepoRefCache()
      _resetGiteaPullRequestScanCache()
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([]))
      vi.stubGlobal('fetch', fetchMock)

      await getGiteaPullRequestForBranch('/repo', 'feature/x')

      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
      expect(headers?.Authorization).toBe('token gitea-token')
    }
  })

  it('does not send the PAT over a cleartext http configured base URL (finding 2)', async () => {
    process.env.ORCA_GITEA_API_BASE_URL = 'http://gitea.internal'
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([]))
    vi.stubGlobal('fetch', fetchMock)

    await getGiteaPullRequestForBranch('/repo', 'feature/x')

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBeUndefined()
  })

  it('binds the PAT to the configured instance host and keeps sending it there', async () => {
    // Regression guard: the host-binding must not drop the token for a legitimate
    // https request whose host matches the configured ORCA_GITEA_API_BASE_URL.
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com'
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 7
    })
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBe('token gitea-token')
  })

  it('reports a page-cap-truncated scan as unavailable in the strict lookup (duplicate-PR guard)', async () => {
    // Gitea has no head-branch filter: every page is full up to the cap and the
    // branch's older PR is beyond it, so the scan misses without confirming absence.
    const fullPage = Array.from({ length: 50 }, (_, index) =>
      giteaPr(index + 100, `other/${index}`)
    )
    const fetchMock = vi.fn(async () => Response.json(fullPage))
    vi.stubGlobal('fetch', fetchMock)

    // Display refresh (swallowing) stays null under truncation.
    await expect(getGiteaPullRequestForBranch('/repo', 'feature/absent')).resolves.toBeNull()
    // Create preflight (strict) must not treat a truncated miss as a definitive
    // not_found, or it would open a duplicate PR for a branch that already has one.
    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/absent')).rejects.toThrow(
      /page cap/
    )
  })

  it('expires successful scans and bounds retained repository listings', async () => {
    vi.useFakeTimers()
    try {
      let listCalls = 0
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url)
        if (parsed.pathname.endsWith('/status')) {
          return Response.json({ state: 'success' })
        }
        listCalls++
        return Response.json([giteaPr()])
      })
      vi.stubGlobal('fetch', fetchMock)

      await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
      expect(_getGiteaPullRequestScanCacheSize()).toBe(1)
      await vi.advanceTimersByTimeAsync(30_001)
      expect(_getGiteaPullRequestScanCacheSize()).toBe(0)
      await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
      expect(listCalls).toBe(2)

      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          scanGiteaPullRequests(`repo-${index}`, async () => [], 50, 5)
        )
      )
      expect(_getGiteaPullRequestScanCacheSize()).toBe(32)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an in-flight scan re-cache results from before an invalidation', async () => {
    let releaseFirstScan!: () => void
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      listCalls++
      if (listCalls === 1) {
        // First scan is in flight (pre-create listing) when the invalidation lands.
        await firstScanGate
        return Response.json([giteaPr(7, 'feature/old')])
      }
      return Response.json([giteaPr(7, 'feature/old'), giteaPr(8, 'feature/new')])
    })
    vi.stubGlobal('fetch', fetchMock)

    const staleScanRead = getGiteaPullRequestForBranch('/repo', 'feature/old')
    const { invalidateGiteaPullRequestScanForRepo, getGiteaRepoSlug } = await import('./client')
    const repo = await getGiteaRepoSlug('/repo')
    invalidateGiteaPullRequestScanForRepo(repo!)
    releaseFirstScan()
    await staleScanRead

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/new')).resolves.toMatchObject({
      number: 8
    })
    expect(listCalls).toBe(2)
  })

  it('uses an API base URL override for subpath or non-standard deployments', async () => {
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com/code'
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/commits/abc123/status')) {
        return Response.json({ state: 'pending' })
      }
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 7,
      status: 'pending'
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://git.example.com/code/api/v1/repos/team/repo/pulls'
    )
  })

  it('falls back to a linked PR number when branch lookup misses', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/commits/abc123/status')) {
        return Response.json({ state: 'success' })
      }
      if (requestUrl.endsWith('/pulls/42')) {
        return Response.json(giteaPr(42, 'renamed-local-branch'))
      }
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'local-name', 42)).resolves.toMatchObject({
      number: 42,
      status: 'success'
    })
  })

  it('reports configured token auth without a global API base URL', async () => {
    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: null,
      baseUrl: null,
      tokenConfigured: true
    })
  })

  it('verifies token auth when a global API base URL is configured', async () => {
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com'
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ login: 'gitea-user' })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'gitea-user',
      baseUrl: 'https://git.example.com/api/v1',
      tokenConfigured: true
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://git.example.com/api/v1/user')
  })

  it('cancels unread error-response bodies so bundled undici cannot crash on socket close', async () => {
    let cancelledBodies = 0
    const fetchMock = vi.fn(async () =>
      cancelTrackingResponse(502, () => {
        cancelledBodies += 1
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await getGiteaPullRequestForBranch('/repo', 'refs/heads/feature/gitea')

    expect(fetchMock).toHaveBeenCalled()
    expect(cancelledBodies).toBe(fetchMock.mock.calls.length)
  })

  it('refuses to follow a cross-origin redirect on the read path (SSRF)', async () => {
    // Read-path parity with the write path: the base URL falls back to the untrusted
    // git remote, so a 30x must not steer the request onto a foreign host.
    const contactedHosts: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      contactedHosts.push(new URL(String(url)).host)
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()

    expect(fetchMock).toHaveBeenCalled()
    expect([...new Set(contactedHosts)]).toEqual(['git.example.com'])
  })

  it('rejects a read response that streams past the byte cap (main-process OOM)', async () => {
    // 32 x 1 MiB (reused buffer keeps the test light) overruns the 16 MiB cap.
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (emitted >= 32) {
                controller.close()
                return
              }
              emitted += 1
              controller.enqueue(chunk)
            }
          })
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')).rejects.toThrow(
      /exceeds maximum allowed size/
    )
  })
})
