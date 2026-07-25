// Shared policy for which hosts may receive the Bitbucket credential (OAuth access token
// or email/app-password Basic), mirroring the Gitea and Azure DevOps policies so the three
// providers cannot drift. ORCA_BITBUCKET_API_BASE_URL repoints the client at a self-hosted
// instance, so the credential must be bound to that exact host and must never travel in
// cleartext to a host that could be off-machine.

import { isLoopbackHost } from '../source-control/loopback-host'

/**
 * Whether the Bitbucket credential may be attached for a request to `url`.
 *
 * Loopback is trusted under any scheme (the SSH-tunnel / local Data Center case). Every
 * other host must be reached over https AND match the configured API base URL's host, so
 * a cleartext base URL — or a request that drifted off it — never carries the credential.
 */
export function bitbucketTokenAllowedForHost(url: URL, apiBaseUrl: string): boolean {
  if (!isLoopbackHost(url.hostname) && url.protocol !== 'https:') {
    return false
  }
  try {
    return url.host === new URL(apiBaseUrl).host
  } catch {
    return false
  }
}
