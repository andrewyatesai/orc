import { describe, expect, it } from 'vitest'
import { giteaTokenAllowedForHost } from './token-host-policy'

const allowed = (remote: string, base: string | null = null): boolean =>
  giteaTokenAllowedForHost(new URL(remote), base)

describe('giteaTokenAllowedForHost — token-only mode (host derived from untrusted remote)', () => {
  it('trusts loopback over any scheme (SSH-tunnel / local instance)', () => {
    expect(allowed('http://127.0.0.1:3000/o/r')).toBe(true)
    expect(allowed('http://localhost:3000/o/r')).toBe(true)
    expect(allowed('https://[::1]/o/r')).toBe(true)
  })

  it('does NOT treat a 127.x DNS host as loopback (prefix-match exploit)', () => {
    // Why: a `127.` prefix match classified this DNS host as loopback and sent the PAT in
    // CLEARTEXT to it. It must be refused over http (not loopback); over https it is only a
    // normal public host (token-only trusts public https, the documented residual).
    expect(allowed('http://127.attacker.example/o/r')).toBe(false)
    expect(allowed('https://127.attacker.example/o/r')).toBe(true)
  })

  it('refuses non-loopback internal/metadata literals even over https', () => {
    expect(allowed('https://169.254.169.254/o/r')).toBe(false)
    expect(allowed('https://10.0.0.5/o/r')).toBe(false)
    expect(allowed('https://192.168.1.10/o/r')).toBe(false)
    expect(allowed('https://172.16.0.1/o/r')).toBe(false)
    expect(allowed('https://[fe80::1]/o/r')).toBe(false)
  })

  it('allows a public host over https but refuses cleartext http', () => {
    expect(allowed('https://gitea.example.com/o/r')).toBe(true)
    expect(allowed('http://gitea.example.com/o/r')).toBe(false)
  })
})

describe('giteaTokenAllowedForHost — configured base URL binds to that host', () => {
  it('sends only to the exact configured host, over https', () => {
    expect(allowed('https://git.example.com/o/r', 'https://git.example.com')).toBe(true)
    expect(allowed('https://evil.example.com/o/r', 'https://git.example.com')).toBe(false)
  })

  it('refuses a cleartext http configured host that is not loopback', () => {
    expect(allowed('http://gitea.internal/o/r', 'http://gitea.internal')).toBe(false)
  })

  it('allows a configured loopback host over http (tunnelled instance)', () => {
    expect(allowed('http://127.0.0.1:8080/o/r', 'http://127.0.0.1:8080')).toBe(true)
  })
})
