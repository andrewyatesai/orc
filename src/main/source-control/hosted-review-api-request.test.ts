import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostedReviewApiRequestError, requestHostedReviewJson } from './hosted-review-api-request'

const OLD_FETCH = globalThis.fetch
const ONE_MB = 1024 * 1024

function streamingBody(chunk: Uint8Array, chunkCount: number): ReadableStream<Uint8Array> {
  let emitted = 0
  return new ReadableStream({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close()
        return
      }
      emitted += 1
      controller.enqueue(chunk)
    }
  })
}

describe('requestHostedReviewJson', () => {
  afterEach(() => {
    globalThis.fetch = OLD_FETCH
  })

  it('returns parsed JSON on a successful response', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ number: 7 })) as never
    await expect(
      requestHostedReviewJson<{ number: number }>(
        new URL('https://api.example.com/v1/pulls'),
        { method: 'GET' },
        5000
      )
    ).resolves.toEqual({ number: 7 })
  })

  it('refuses to follow a redirect to a different host and never re-issues the request there', async () => {
    const contactedHosts: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      contactedHosts.push(new URL(String(input)).host)
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' }
      })
    })
    globalThis.fetch = fetchMock as never

    await expect(
      requestHostedReviewJson(
        new URL('https://forge.example.com/api/pulls'),
        { method: 'POST', headers: { Authorization: 'token secret' }, body: '{}' },
        5000
      )
    ).rejects.toBeInstanceOf(HostedReviewApiRequestError)

    // Only the original host was ever contacted; the redirect target was not followed.
    expect(contactedHosts).toEqual(['forge.example.com'])
  })

  it('follows a same-origin redirect', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://forge.example.com/api/v2/pulls' }
        })
      }
      return Response.json({ number: 99 })
    })
    globalThis.fetch = fetchMock as never

    await expect(
      requestHostedReviewJson<{ number: number }>(
        new URL('https://forge.example.com/api/v1/pulls'),
        { method: 'GET' },
        5000
      )
    ).resolves.toEqual({ number: 99 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a response whose Content-Length exceeds the cap without buffering it', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('{}', {
          headers: { 'content-length': String(64 * ONE_MB) }
        })
    ) as never

    await expect(
      requestHostedReviewJson(
        new URL('https://forge.example.com/api/pulls'),
        { method: 'GET' },
        5000
      )
    ).rejects.toMatchObject({ message: 'Response body exceeds maximum allowed size' })
  })

  it('rejects a chunked response that streams past the byte cap', async () => {
    // 32 x 1 MiB (reused buffer keeps the test light) overruns the 16 MiB cap.
    const chunk = new Uint8Array(ONE_MB)
    globalThis.fetch = vi.fn(async () => new Response(streamingBody(chunk, 32))) as never

    await expect(
      requestHostedReviewJson(
        new URL('https://forge.example.com/api/pulls'),
        { method: 'GET' },
        5000
      )
    ).rejects.toMatchObject({ message: 'Response body exceeds maximum allowed size' })
  })
})
