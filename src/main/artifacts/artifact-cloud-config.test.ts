import { describe, expect, it } from 'vitest'
import {
  allowsArtifactCloudAuthOverride,
  resolveArtifactCloudApiUrl
} from './artifact-cloud-config'

// A fork must fail closed: it does not own the upstream vendor host, so an
// unconfigured build resolves to `null` (surfaced as a coded "not configured"
// state) instead of defaulting a signed-in account's token to onorca.dev.
describe('resolveArtifactCloudApiUrl (fork fail-closed)', () => {
  it('returns null when no first-party host is configured for a packaged fork build', () => {
    expect(resolveArtifactCloudApiUrl(undefined, {}, true, false)).toBeNull()
    expect(resolveArtifactCloudApiUrl(undefined, {}, false, false)).toBeNull()
  })

  it('inherits the public host only for a packaged public-identity build', () => {
    expect(resolveArtifactCloudApiUrl(undefined, {}, true, true)).toBe('https://share.onorca.dev')
  })

  it('trusts an explicitly configured artifact host, even in a packaged fork build', () => {
    expect(resolveArtifactCloudApiUrl('https://share.orca-alab.dev', {}, true, false)).toBe(
      'https://share.orca-alab.dev'
    )
    expect(
      resolveArtifactCloudApiUrl(
        undefined,
        { ORCA_ARTIFACTS_API_URL: 'https://share.orca-alab.dev' },
        true,
        false
      )
    ).toBe('https://share.orca-alab.dev')
  })

  it('allows loopback HTTP only in development', () => {
    expect(
      resolveArtifactCloudApiUrl(
        undefined,
        { ORCA_ARTIFACTS_API_URL: 'http://127.0.0.1:45961' },
        false,
        false
      )
    ).toBe('http://127.0.0.1:45961')
    expect(() => resolveArtifactCloudApiUrl('http://127.0.0.1:45961', {}, true, false)).toThrow(
      /HTTPS/
    )
  })

  it('rejects a configured host that carries a path or credentials', () => {
    expect(() =>
      resolveArtifactCloudApiUrl('https://share.orca-alab.dev/path', {}, false, false)
    ).toThrow(/origin/)
  })

  it('allows auth token overrides only in non-production development builds', () => {
    expect(allowsArtifactCloudAuthOverride({}, false)).toBe(true)
    expect(allowsArtifactCloudAuthOverride({ NODE_ENV: 'production' }, false)).toBe(false)
    expect(allowsArtifactCloudAuthOverride({}, true)).toBe(false)
  })
})
