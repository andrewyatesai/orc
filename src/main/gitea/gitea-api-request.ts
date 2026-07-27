import type { GiteaRepoRef } from './repository-ref'
import { giteaTokenAllowedForHost } from './token-host-policy'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  fetchHostedReviewSameOrigin,
  readHostedReviewJsonBody
} from '../source-control/hosted-review-api-request'

const REQUEST_TIMEOUT_MS = 5000

type GiteaAuthConfig = {
  apiBaseUrl: string | null
  token: string | null
}

export type RequestOptions = {
  searchParams?: Record<string, string | number>
  timeoutMs?: number
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

export function getAuthConfig(): GiteaAuthConfig {
  const apiBaseUrl = envValue('ORCA_GITEA_API_BASE_URL')
  return {
    apiBaseUrl: apiBaseUrl ? normalizeGiteaApiBaseUrl(apiBaseUrl) : null,
    token: envValue('ORCA_GITEA_TOKEN')
  }
}

function authHeaders(config: GiteaAuthConfig, requestUrl: URL): Record<string, string> {
  return config.token && giteaTokenAllowedForHost(requestUrl, config.apiBaseUrl)
    ? { Authorization: `token ${config.token}` }
    : {}
}

export function configuredApiBaseUrl(repo: GiteaRepoRef): string {
  return getAuthConfig().apiBaseUrl ?? repo.apiBaseUrl
}

function apiUrl(baseUrl: string, path: string, searchParams?: RequestOptions['searchParams']): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

export async function requestJsonAtBase<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
  // Why: the existing-review lookup behind Create must distinguish a real
  // transport/auth failure from an accepted "no PR". When true, a failed request
  // throws instead of collapsing to null so callers never report false not_found.
  throwOnFailure = false
): Promise<T | null> {
  const config = getAuthConfig()
  try {
    const url = apiUrl(baseUrl, path, options.searchParams)
    // Why: the base URL falls back to the untrusted git remote, so follow only
    // same-origin redirects (a 30x to a foreign host is SSRF, and would outlive the
    // authHeaders host check above) and cap the body a hostile instance can stream.
    const response = await fetchHostedReviewSameOrigin(
      url,
      {
        headers: {
          Accept: 'application/json',
          ...authHeaders(config, url)
        }
      },
      AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    )
    if (!response.ok) {
      await cancelUnreadResponseBody(response)
      if (throwOnFailure) {
        throw new Error(`Gitea request failed: HTTP ${response.status}`)
      }
      return null
    }
    return await readHostedReviewJsonBody<T>(response)
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  }
}

export function requestJson<T>(
  repo: GiteaRepoRef,
  path: string,
  options: RequestOptions = {},
  throwOnFailure = false
): Promise<T | null> {
  return requestJsonAtBase(configuredApiBaseUrl(repo), path, options, throwOnFailure)
}
