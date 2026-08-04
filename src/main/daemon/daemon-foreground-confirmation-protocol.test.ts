import { describe, expect, it } from 'vitest'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

describe('foreground-confirmation daemon protocol', () => {
  it('rejects daemons from before the fresh-confirmation RPC', () => {
    // Fork: PROTOCOL_VERSION lives in the 1000+ fork namespace, not upstream's public 30.
    expect(PROTOCOL_VERSION).toBeGreaterThan(19)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(19)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(22)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(23)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(24)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(25)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(26)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(27)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(28)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(29)
    // Fork: the public range now runs to 30, which is a PREVIOUS version here (the
    // fork's own current is 1021), so a live public v30 daemon is adopted too.
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(30)
  })
})
