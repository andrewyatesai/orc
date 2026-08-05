import { describe, expect, it } from 'vitest'
import {
  deriveRelayCliSecret,
  isRelayAuthSecret,
  mintRelayAuthSecret,
  relayAuthTokenMatchesVerifier,
  relayAuthVerifier
} from './ssh-relay-auth-token'

describe('relay auth token', () => {
  it('mints 256-bit hex secrets that do not repeat', () => {
    const a = mintRelayAuthSecret()
    const b = mintRelayAuthSecret()
    expect(isRelayAuthSecret(a)).toBe(true)
    expect(a).toHaveLength(64)
    expect(a).not.toBe(b)
  })

  it('accepts the matching secret and rejects everything else', () => {
    const secret = mintRelayAuthSecret()
    const verifier = relayAuthVerifier(secret)

    expect(relayAuthTokenMatchesVerifier(secret, verifier)).toBe(true)
    expect(relayAuthTokenMatchesVerifier(mintRelayAuthSecret(), verifier)).toBe(false)
    expect(relayAuthTokenMatchesVerifier(secret.slice(0, 63), verifier)).toBe(false)
    expect(relayAuthTokenMatchesVerifier(`${secret}x`, verifier)).toBe(false)
    expect(relayAuthTokenMatchesVerifier(secret.toUpperCase(), verifier)).toBe(false)
  })

  it('rejects absent, empty, and non-string tokens instead of throwing', () => {
    const verifier = relayAuthVerifier(mintRelayAuthSecret())
    expect(relayAuthTokenMatchesVerifier(undefined, verifier)).toBe(false)
    expect(relayAuthTokenMatchesVerifier('', verifier)).toBe(false)
    expect(relayAuthTokenMatchesVerifier({}, verifier)).toBe(false)
    expect(relayAuthTokenMatchesVerifier(null, verifier)).toBe(false)
  })

  // Why: a daemon launched with no verifier must refuse everyone, so an empty or
  // malformed verifier can never be satisfiable — not even by an empty token.
  it('never matches a missing or malformed verifier', () => {
    expect(relayAuthTokenMatchesVerifier('', '')).toBe(false)
    expect(relayAuthTokenMatchesVerifier('anything', '')).toBe(false)
    expect(relayAuthTokenMatchesVerifier('anything', undefined)).toBe(false)
    expect(relayAuthTokenMatchesVerifier('anything', 'not-hex')).toBe(false)
  })

  it('derives a CLI secret that is distinct from the control secret and does not reveal it', () => {
    const control = mintRelayAuthSecret()
    const cli = deriveRelayCliSecret(control)

    expect(cli).not.toBe(control)
    expect(isRelayAuthSecret(cli)).toBe(true)
    expect(deriveRelayCliSecret(control)).toBe(cli)
    expect(deriveRelayCliSecret(mintRelayAuthSecret())).not.toBe(cli)
    // The pane-side credential must not satisfy the control gate.
    expect(relayAuthTokenMatchesVerifier(cli, relayAuthVerifier(control))).toBe(false)
  })

  // Why: the verifier is what the remote host gets to see. If it were reversible,
  // shipping it in argv would ship the secret.
  it('publishes a verifier that is not the secret', () => {
    const secret = mintRelayAuthSecret()
    expect(relayAuthVerifier(secret)).not.toBe(secret)
    expect(
      relayAuthTokenMatchesVerifier(relayAuthVerifier(secret), relayAuthVerifier(secret))
    ).toBe(false)
  })
})
