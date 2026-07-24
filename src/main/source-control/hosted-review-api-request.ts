export class HostedReviewApiRequestError extends Error {
  readonly status: number | null
  readonly timedOut: boolean

  constructor(message: string, options: { status?: number | null; timedOut?: boolean } = {}) {
    super(message)
    this.name = 'HostedReviewApiRequestError'
    this.status = options.status ?? null
    this.timedOut = options.timedOut ?? false
  }
}

// Cap on forge response bodies read into the main process. A malicious/compromised
// self-hosted instance (base URL is remote-derived) could otherwise stream an unbounded
// body via response.json() and OOM-kill the Electron main process.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
// Bound redirect chains so a same-origin loop cannot spin forever.
const MAX_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // best-effort drain; ignore
  }
}

// Read at most maxBytes from a response body. Rejects (or, for error text, truncates)
// rather than buffering an attacker-influenced unbounded payload.
async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  onExceeded: 'throw' | 'truncate'
): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const declaredBytes = Number(declared)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes && onExceeded === 'throw') {
      await cancelBody(response)
      throw new HostedReviewApiRequestError('Response body exceeds maximum allowed size', {
        status: response.status
      })
    }
  }
  const body = response.body
  if (!body) {
    return Buffer.alloc(0)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value) {
        continue
      }
      total += value.byteLength
      if (total > maxBytes) {
        if (onExceeded === 'throw') {
          await reader.cancel()
          throw new HostedReviewApiRequestError('Response body exceeds maximum allowed size', {
            status: response.status
          })
        }
        // truncate: keep only up to the cap, then stop
        const remaining = maxBytes - (total - value.byteLength)
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining))
        }
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

async function readResponseText(response: Response): Promise<string> {
  try {
    const buffer = await readBoundedBytes(response, MAX_RESPONSE_BYTES, 'truncate')
    return buffer.toString('utf-8')
  } catch {
    return ''
  }
}

// Follow only same-origin redirects. A base URL is remote/config-derived for self-hosted
// forges, so a 30x to a different host is an SSRF vector (and would risk carrying the forge
// token onward); fail closed instead of letting fetch's default 'follow' chase a new host.
async function fetchSameOrigin(
  url: URL,
  init: Omit<RequestInit, 'signal' | 'redirect'>,
  signal: AbortSignal
): Promise<Response> {
  let currentUrl = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(currentUrl, { ...init, signal, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }
    const location = response.headers.get('location')
    if (location === null) {
      return response
    }
    let next: URL
    try {
      next = new URL(location, currentUrl)
    } catch {
      await cancelBody(response)
      throw new HostedReviewApiRequestError('Invalid redirect location', {
        status: response.status
      })
    }
    if (next.origin !== currentUrl.origin) {
      await cancelBody(response)
      throw new HostedReviewApiRequestError('Refusing to follow cross-origin redirect', {
        status: response.status
      })
    }
    await cancelBody(response)
    currentUrl = next
  }
  throw new HostedReviewApiRequestError('Too many redirects')
}

export async function requestHostedReviewJson<T>(
  url: URL,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number
): Promise<T> {
  try {
    const { redirect: _ignoredRedirect, ...safeInit } = init
    const response = await fetchSameOrigin(url, safeInit, AbortSignal.timeout(timeoutMs))
    if (!response.ok) {
      const body = await readResponseText(response)
      throw new HostedReviewApiRequestError(body || response.statusText, {
        status: response.status
      })
    }
    const buffer = await readBoundedBytes(response, MAX_RESPONSE_BYTES, 'throw')
    return JSON.parse(buffer.toString('utf-8')) as T
  } catch (error) {
    if (error instanceof HostedReviewApiRequestError) {
      throw error
    }
    // AbortSignal.timeout() rejects with a TimeoutError, not an AbortError.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new HostedReviewApiRequestError('Request timed out', { timedOut: true })
    }
    throw error
  }
}
