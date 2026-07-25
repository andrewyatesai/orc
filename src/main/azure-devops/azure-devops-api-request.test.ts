import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestAzureDevOpsJsonAtBase } from './azure-devops-api-request'

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
