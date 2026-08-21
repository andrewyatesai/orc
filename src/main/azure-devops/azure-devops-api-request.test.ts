import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAzureDevOpsPreviewApiVersionCache,
  requestAzureDevOpsJson,
  requestAzureDevOpsJsonAtBase
} from './azure-devops-api-request'
import type { AzureDevOpsRepoRef } from './repository-ref'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

type CapturedRequest = { url: string; authorization: string | null }

function stubFetch(): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get('authorization') })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as never
  return { calls }
}

beforeEach(() => {
  process.env = { ...OLD_ENV }
  delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  delete process.env.ORCA_AZURE_DEVOPS_TOKEN
  delete process.env.ORCA_AZURE_DEVOPS_PAT
  delete process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN
  delete process.env.ORCA_AZURE_DEVOPS_USERNAME
})

afterEach(() => {
  process.env = OLD_ENV
  globalThis.fetch = OLD_FETCH
  vi.restoreAllMocks()
})

describe('requestAzureDevOpsJsonAtBase token-to-host binding', () => {
  it('does not attach the PAT over cleartext http to a repo-derived Server host', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'super-secret-pat'
    const { calls } = stubFetch()

    await requestAzureDevOpsJsonAtBase(
      'http://azure.internal/col/proj',
      '/_apis/git/repositories/repo'
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url.startsWith('http://azure.internal/')).toBe(true)
    // The PAT must never travel in cleartext.
    expect(calls[0].authorization).toBeNull()
  })

  it('does not attach the PAT to an unconfigured https Server host (wrong-host exfil)', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'super-secret-pat'
    const { calls } = stubFetch()

    await requestAzureDevOpsJsonAtBase(
      'https://attacker.example/proj',
      '/_apis/git/repositories/repo'
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].authorization).toBeNull()
  })

  it('does not attach the PAT when the configured base URL host differs from the request host', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'super-secret-pat'
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'https://tfs.corp.example/tfs/col'
    const { calls } = stubFetch()

    await requestAzureDevOpsJsonAtBase(
      'https://attacker.example/proj',
      '/_apis/git/repositories/repo'
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].authorization).toBeNull()
  })

  it('attaches Basic auth over https to a Microsoft cloud host without a configured base URL', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'super-secret-pat'
    process.env.ORCA_AZURE_DEVOPS_USERNAME = 'me'
    const { calls } = stubFetch()

    await requestAzureDevOpsJsonAtBase(
      'https://dev.azure.com/acme/Project',
      '/_apis/git/repositories/repo'
    )

    expect(calls).toHaveLength(1)
    const expected = `Basic ${Buffer.from('me:super-secret-pat').toString('base64')}`
    expect(calls[0].authorization).toBe(expected)
  })

  it('attaches Basic auth over https to a *.visualstudio.com cloud host', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'super-secret-pat'
    const { calls } = stubFetch()

    await requestAzureDevOpsJsonAtBase(
      'https://acme.visualstudio.com/Project',
      '/_apis/git/repositories/repo'
    )

    expect(calls[0].authorization).toBe(
      `Basic ${Buffer.from(':super-secret-pat').toString('base64')}`
    )
  })

  it('attaches auth to an explicitly configured https self-hosted host that matches the request host', async () => {
    process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN = 'oauth-access-token'
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'https://tfs.corp.example/tfs/col/proj'
    const { calls } = stubFetch()

    await requestAzureDevOpsJsonAtBase(
      'https://tfs.corp.example/tfs/col/proj',
      '/_apis/git/repositories/repo'
    )

    expect(calls[0].authorization).toBe('Bearer oauth-access-token')
  })

  it('refuses to follow a cross-origin redirect on the read path (SSRF)', async () => {
    // Read-path parity with the write path: a Server base URL is repo-derived, so a 30x
    // must not steer the request onto a foreign host.
    const contactedHosts: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      contactedHosts.push(new URL(String(input)).host)
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' }
      })
    }) as never

    await expect(
      requestAzureDevOpsJsonAtBase(
        'https://tfs.corp.example/tfs/col',
        '/_apis/git/repositories/repo',
        {},
        true
      )
    ).rejects.toThrow(/cross-origin redirect/)

    expect(contactedHosts).toEqual(['tfs.corp.example'])
  })

  it('rejects a read response that streams past the byte cap (main-process OOM)', async () => {
    // 32 x 1 MiB (reused buffer keeps the test light) overruns the 16 MiB cap.
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    globalThis.fetch = vi.fn(
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
    ) as never

    await expect(
      requestAzureDevOpsJsonAtBase(
        'https://tfs.corp.example/tfs/col',
        '/_apis/git/repositories/repo',
        {},
        true
      )
    ).rejects.toThrow(/exceeds maximum allowed size/)
  })

  it('swallows a transport failure to null when throwOnFailure is off', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://attacker.example/x' } })
    ) as never

    await expect(
      requestAzureDevOpsJsonAtBase(
        'https://tfs.corp.example/tfs/col',
        '/_apis/git/repositories/repo'
      )
    ).resolves.toBeNull()
  })

  it('does not attach auth when the configured self-hosted base URL is cleartext http', async () => {
    process.env.ORCA_AZURE_DEVOPS_TOKEN = 'super-secret-pat'
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'http://tfs.corp.example/tfs/col'
    const { calls } = stubFetch()

    // Even to the same host, an http request must not carry the token.
    await requestAzureDevOpsJsonAtBase(
      'http://tfs.corp.example/tfs/col',
      '/_apis/git/repositories/repo'
    )

    expect(calls[0].authorization).toBeNull()
  })
})

const SERVER_BASE = 'https://ado.example.com:8443/tfs/MyCollection'

function previewRejection(): Response {
  return new Response(
    JSON.stringify({
      message:
        'The requested version "7.1" of the resource is under preview. The -preview flag must be supplied in the api-version for such requests.',
      typeKey: 'VssInvalidPreviewVersionException'
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  )
}

function serverRepoRef(): AzureDevOpsRepoRef {
  return {
    host: 'ado.example.com',
    organization: null,
    project: 'MyProject',
    repository: 'my-repo',
    apiBaseUrl: `${SERVER_BASE}/MyProject`,
    webBaseUrl: `${SERVER_BASE}/MyProject/_git/my-repo`
  }
}

describe('Azure DevOps API request preview api-version and Git base (STA-3494)', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    _resetAzureDevOpsPreviewApiVersionCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetAzureDevOpsPreviewApiVersionCache()
  })

  it('retries with -preview when Azure DevOps Server rejects the api-version', async () => {
    const versions: (string | null)[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      versions.push(url.searchParams.get('api-version'))
      if (!url.searchParams.get('api-version')?.endsWith('-preview')) {
        return previewRejection()
      }
      return Response.json({ authenticatedUser: { providerDisplayName: 'Server User' } })
    }) as never

    await expect(
      requestAzureDevOpsJsonAtBase(SERVER_BASE, '/_apis/connectionData')
    ).resolves.toEqual({ authenticatedUser: { providerDisplayName: 'Server User' } })
    expect(versions).toEqual(['7.1', '7.1-preview'])
  })

  it('remembers the -preview requirement per origin after the first rejection', async () => {
    const versions: (string | null)[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      versions.push(url.searchParams.get('api-version'))
      if (!url.searchParams.get('api-version')?.endsWith('-preview')) {
        return previewRejection()
      }
      return Response.json({ ok: true })
    }) as never

    const base = 'https://ado-sticky.example.com/tfs/MyCollection'
    await requestAzureDevOpsJsonAtBase(base, '/_apis/connectionData')
    await requestAzureDevOpsJsonAtBase(base, '/_apis/connectionData')
    // The first request learns the suffix; the second must not repeat the 400 round trip.
    expect(versions).toEqual(['7.1', '7.1-preview', '7.1-preview'])
  })

  it('does not retry a 400 that is not a preview-version rejection', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ message: 'A project name is required.' }, { status: 400 })
    )
    globalThis.fetch = fetchMock as never

    await expect(
      requestAzureDevOpsJsonAtBase(
        'https://ado-other.example.com/tfs/Coll',
        '/_apis/connectionData'
      )
    ).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the remote-derived project base for Git endpoints when the configured base shares its origin', async () => {
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = SERVER_BASE
    const paths: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname)
      return Response.json({ id: 'repo-guid' })
    }) as never

    await requestAzureDevOpsJson(serverRepoRef(), '/_apis/git/repositories/my-repo')
    // The collection-level env base must not strip the project segment Git endpoints need.
    expect(paths).toEqual(['/tfs/MyCollection/MyProject/_apis/git/repositories/my-repo'])
  })

  it('keeps a cross-origin configured base URL as an override for Git endpoints', async () => {
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'http://127.0.0.1:8123/acme/Project'
    const origins: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      origins.push(new URL(String(input)).origin)
      return Response.json({ id: 'repo-guid' })
    }) as never

    await requestAzureDevOpsJson(serverRepoRef(), '/_apis/git/repositories/my-repo')
    expect(origins).toEqual(['http://127.0.0.1:8123'])
  })

  it('keeps a same-origin non-ancestor base URL as a Git endpoint override', async () => {
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'https://ado.example.com:8443/rewrite/MyProject'
    const paths: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname)
      return Response.json({ id: 'repo-guid' })
    }) as never

    await requestAzureDevOpsJson(serverRepoRef(), '/_apis/git/repositories/my-repo')
    expect(paths).toEqual(['/rewrite/MyProject/_apis/git/repositories/my-repo'])
  })
})
