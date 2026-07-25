import { describe, expect, it } from 'vitest'
import { bitbucketTokenAllowedForHost } from './token-host-policy'

const CLOUD = 'https://api.bitbucket.org/2.0'

const allowed = (requestUrl: string, base: string): boolean =>
  bitbucketTokenAllowedForHost(new URL(requestUrl), base)

describe('bitbucketTokenAllowedForHost', () => {
  it('allows the default Bitbucket Cloud host over https', () => {
    expect(allowed('https://api.bitbucket.org/2.0/user', CLOUD)).toBe(true)
  })

  it('refuses a host that differs from the configured base URL', () => {
    // A request that drifted off the configured host (e.g. via a redirect) must not
    // carry the credential, even to another Bitbucket-looking host over https.
    expect(allowed('https://attacker.example/2.0/user', CLOUD)).toBe(false)
    expect(allowed('https://bitbucket.org.attacker.example/2.0/user', CLOUD)).toBe(false)
  })

  it('refuses a cleartext http self-hosted base URL (credential in the clear)', () => {
    // The gap this closes: ORCA_BITBUCKET_API_BASE_URL could point at a plain-http
    // instance and the credential was attached unconditionally.
    const base = 'http://bitbucket.internal/2.0'
    expect(allowed('http://bitbucket.internal/2.0/user', base)).toBe(false)
  })

  it('refuses cleartext http to internal and cloud-metadata literals', () => {
    expect(allowed('http://169.254.169.254/2.0/user', 'http://169.254.169.254/2.0')).toBe(false)
    expect(allowed('http://10.0.0.5/2.0/user', 'http://10.0.0.5/2.0')).toBe(false)
  })

  it('allows an https self-hosted host that matches the configured base URL', () => {
    const base = 'https://bitbucket.corp.example/2.0'
    expect(allowed('https://bitbucket.corp.example/2.0/user', base)).toBe(true)
  })

  it('allows loopback over http (SSH-tunnel / local Data Center)', () => {
    expect(allowed('http://127.0.0.1:7990/2.0/user', 'http://127.0.0.1:7990/2.0')).toBe(true)
    expect(allowed('http://localhost:7990/2.0/user', 'http://localhost:7990/2.0')).toBe(true)
  })

  it('does not treat a 127.x DNS host as loopback', () => {
    const base = 'http://127.attacker.example/2.0'
    expect(allowed('http://127.attacker.example/2.0/user', base)).toBe(false)
  })

  it('binds to host including port, and refuses an unparseable base URL', () => {
    expect(
      allowed('https://bitbucket.corp.example:8443/2.0/user', 'https://bitbucket.corp.example/2.0')
    ).toBe(false)
    expect(allowed('https://api.bitbucket.org/2.0/user', 'not-a-url')).toBe(false)
  })
})
