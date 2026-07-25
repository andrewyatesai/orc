import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  getBitbucketAuthStatus,
  getBitbucketPullRequestForBranch,
  getBitbucketPullRequestForBranchOrThrow
} from './client'
import { _resetBitbucketRepoRefCache } from './repository-ref'

const OLD_ENV = process.env

function bitbucketPr(id = 7) {
  return {
    id,
    title: 'Add Bitbucket',
    state: 'OPEN',
    updated_on: '2026-05-10T00:00:00.000Z',
    links: { html: { href: `https://bitbucket.org/team/repo/pull-requests/${id}` } },
    source: {
      branch: { name: 'feature/bitbucket' },
      commit: { hash: 'abc123' },
      repository: { full_name: 'team/repo' }
    },
    destination: {
      branch: { name: 'main' },
      repository: { full_name: 'team/repo' }
    }
  }
}

describe('Bitbucket client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_BITBUCKET_API_BASE_URL = 'https://api.test.local/2.0'
    process.env.ORCA_BITBUCKET_EMAIL = 'user@example.com'
    process.env.ORCA_BITBUCKET_API_TOKEN = 'token'
    delete process.env.ORCA_BITBUCKET_ACCESS_TOKEN
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@bitbucket.org:team/repo.git\n',
      stderr: ''
    })
    _resetBitbucketRepoRefCache()
    vi.unstubAllGlobals()
  })

  it('fetches a branch pull request and commit build status', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).includes('/statuses/build')) {
        return Response.json({ values: [{ state: 'SUCCESSFUL' }] })
      }
      return Response.json({ values: [bitbucketPr()] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/bitbucket')
    ).resolves.toEqual({
      number: 7,
      title: 'Add Bitbucket',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/7',
      status: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })

    const firstCall = fetchMock.mock.calls[0]
    const listUrl = String(firstCall?.[0])
    const listInit = firstCall?.[1]
    if (!listInit) {
      throw new Error('expected request init')
    }
    const parsed = new URL(listUrl)
    expect(parsed.pathname).toBe('/2.0/repositories/team/repo/pullrequests')
    expect(parsed.searchParams.get('q')).toBe(
      'source.branch.name = "feature/bitbucket" AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")'
    )
    expect(parsed.searchParams.getAll('state')).toEqual([
      'OPEN',
      'MERGED',
      'DECLINED',
      'SUPERSEDED'
    ])
    expect((listInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('user@example.com:token').toString('base64')}`
    )
  })

  it('getBitbucketPullRequestForBranchOrThrow surfaces a failure instead of null (finding 4)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    // The swallowing variant collapses a real failure into a false "no PR".
    await expect(getBitbucketPullRequestForBranch('/repo', 'feature/bitbucket')).resolves.toBeNull()
    // The throwing variant makes the failure visible so eligibility records
    // `unavailable` rather than a false "No pull request found".
    await expect(
      getBitbucketPullRequestForBranchOrThrow('/repo', 'feature/bitbucket')
    ).rejects.toThrow(/Bitbucket request failed/)
  })

  it('falls back to a linked PR number when branch lookup misses', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      if (String(url).endsWith('/pullrequests/42')) {
        return Response.json(bitbucketPr(42))
      }
      return Response.json({ values: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketPullRequestForBranch('/repo', 'different', 42)).resolves.toMatchObject(
      {
        number: 42,
        status: 'neutral'
      }
    )
  })

  it('reports env-token auth status through the Bitbucket /user endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ username: 'bitbucket-user' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'bitbucket-user'
    })
  })

  it('cancels unread error-response bodies so bundled undici cannot crash on socket close', async () => {
    let cancelledBodies = 0
    const fetchMock = vi.fn(async () =>
      cancelTrackingResponse(502, () => {
        cancelledBodies += 1
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/bitbucket')

    expect(fetchMock).toHaveBeenCalled()
    expect(cancelledBodies).toBe(fetchMock.mock.calls.length)
  })

  it('refuses to follow a cross-origin redirect on the read path (SSRF)', async () => {
    const contactedHosts: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      contactedHosts.push(new URL(String(url)).host)
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketPullRequestForBranch('/repo', 'feature/bitbucket')).resolves.toBeNull()

    expect(fetchMock).toHaveBeenCalled()
    expect([...new Set(contactedHosts)]).toEqual(['api.test.local'])
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

    await expect(
      getBitbucketPullRequestForBranchOrThrow('/repo', 'feature/bitbucket')
    ).rejects.toThrow(/exceeds maximum allowed size/)
  })

  it('does not attach the credential when the configured base URL is cleartext http', async () => {
    // The gap this closes: ORCA_BITBUCKET_API_BASE_URL had no host/scheme policy, so the
    // app password travelled in the clear to whatever host it named.
    process.env.ORCA_BITBUCKET_API_BASE_URL = 'http://bitbucket.internal/2.0'
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      Response.json({ values: [] })
    )
    vi.stubGlobal('fetch', fetchMock)

    await getBitbucketPullRequestForBranch('/repo', 'feature/bitbucket')

    expect(fetchMock).toHaveBeenCalled()
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBeUndefined()
  })

  it('still attaches the credential to a loopback base URL over http (tunnelled instance)', async () => {
    process.env.ORCA_BITBUCKET_API_BASE_URL = 'http://127.0.0.1:7990/2.0'
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      Response.json({ values: [] })
    )
    vi.stubGlobal('fetch', fetchMock)

    await getBitbucketPullRequestForBranch('/repo', 'feature/bitbucket')

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBe(
      `Basic ${Buffer.from('user@example.com:token').toString('base64')}`
    )
  })
})
