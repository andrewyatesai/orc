import { describe, expect, it } from 'vitest'
import { isLoopbackHost } from './loopback-host'

describe('isLoopbackHost', () => {
  it('accepts the loopback names and any complete 127/8 address', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.255.255.254')).toBe(true)
  })

  it('rejects a 127.x DNS host (the prefix-match exploit)', () => {
    // Why: a `127.` prefix match classified these as loopback, which let a token be
    // attached over cleartext http to an attacker-resolvable name.
    expect(isLoopbackHost('127.attacker.example')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.attacker.example')).toBe(false)
  })

  it('rejects non-loopback and internal literals', () => {
    expect(isLoopbackHost('169.254.169.254')).toBe(false)
    expect(isLoopbackHost('10.0.0.5')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
    expect(isLoopbackHost('fe80::1')).toBe(false)
    expect(isLoopbackHost('example.com')).toBe(false)
  })

  it('normalizes case and IPv6 brackets, and is idempotent on a normalized host', () => {
    // Callers pass either a raw url.hostname or one they already normalized.
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })
})
