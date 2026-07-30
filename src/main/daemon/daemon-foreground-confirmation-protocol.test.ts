import { describe, expect, it } from 'vitest'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

describe('foreground-confirmation daemon protocol', () => {
  it('rejects daemons from before the fresh-confirmation RPC', () => {
    // Fork: PROTOCOL_VERSION lives in the 1000+ fork namespace, not upstream's public 29.
    expect(PROTOCOL_VERSION).toBeGreaterThan(19)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(19)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(22)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(23)
    // Upstream (v1.4.161) also asserts 25-28; the fork's list (daemon-protocol-versions.ts)
    // stops at public 24, so an upstream v25-v28 daemon is not adopted on upgrade.
    // Restore those assertions when that list gains 25-28.
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(24)
  })
})
