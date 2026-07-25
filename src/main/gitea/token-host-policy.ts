// Shared policy for which hosts may receive the Gitea PAT, used by BOTH the read
// path (client.ts) and the write/create path (pull-request-creation.ts) so they
// cannot drift. In token-only mode the request host is derived from the untrusted
// git remote, so a malicious/mistyped remote must not exfiltrate the PAT.

import { isLoopbackHost } from '../source-control/loopback-host'

// Why: non-loopback internal / link-local / metadata literals the PAT must never
// follow (169.254.169.254 cloud metadata, 10.x, 192.168.x, 172.16-31.x, ::, fe80::,
// fc00::/7, IPv4-mapped). Loopback is checked first, so ::ffff:127.* never lands here.
function isInternalHost(host: string): boolean {
  return (
    /^(0|10|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host) ||
    host === '::' ||
    /^(fe80:|f[cd]|::ffff:)/.test(host)
  )
}

// Whether the Gitea PAT may be attached for a request to `url`. Loopback is trusted
// (any scheme). Otherwise require https; in token-only mode (no configured base URL)
// also refuse non-loopback internal/metadata literals; when a base URL is configured
// bind strictly to that host so the token can't follow a foreign one.
export function giteaTokenAllowedForHost(url: URL, configuredApiBaseUrl: string | null): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = isLoopbackHost(host)
  if (!loopback && url.protocol !== 'https:') {
    return false
  }
  if (configuredApiBaseUrl) {
    try {
      return url.host === new URL(configuredApiBaseUrl).host
    } catch {
      return false
    }
  }
  return loopback || !isInternalHost(host)
}
