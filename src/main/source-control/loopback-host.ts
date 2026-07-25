// Why: loopback is the SSH-tunnel / local-instance case — the connection never leaves the
// machine — so a forge credential may be attached even over cleartext http. Shared by the
// Gitea, Bitbucket, and Azure DevOps token-host policies so the three cannot drift apart.

/**
 * Whether `hostname` is a complete loopback address.
 *
 * Matches a FULL 127/8 address rather than a `127.` prefix, so a DNS host like
 * `127.attacker.example` is never mistaken for loopback and sent a token in cleartext.
 * Normalizes case and IPv6 brackets, so an already-normalized host is safe to pass.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}
