// Per-deployment credential for the relay's control socket.
//
// Why the remote never holds the secret: the socket is 0600, but 0600 is a
// *remote-uid* boundary, and remote-uid is not host-uid — a shared build box,
// jump host, or container account is not the person at the laptop. The relay
// channel forwards `orca.cli` back to the host, so anything that can drive it
// gets code execution on the user's machine. Any secret recoverable from the
// remote (a token file, argv, the relay's own memory) is recoverable by that
// account and would gate nothing, so the host mints and keeps the secret and
// the relay is launched with only a SHA-256 verifier: it can check a token it
// is shown, and can never produce one.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Carries the CLI-role secret into a remote pane so the in-pane `orca` shim can authenticate. */
export const RELAY_AUTH_TOKEN_ENV = 'ORCA_RELAY_TOKEN'

export type RelayAuthRole = 'control' | 'cli'

/** The only method a `cli`-role client may call — exactly what `relay.js --orca-cli` sends. */
export const RELAY_CLI_ROLE_METHODS: readonly string[] = ['orca.cli']

const SECRET_BYTES = 32
const HEX64 = /^[0-9a-f]{64}$/

export function mintRelayAuthSecret(): string {
  return randomBytes(SECRET_BYTES).toString('hex')
}

// Why: a pane's environment is readable by the remote account, and the in-pane
// CLI must carry *some* credential. Deriving one-way keeps that exposure from
// yielding the control secret, so a scraped pane env stays confined to the CLI
// surface instead of unlocking fs/pty/git verbs on the whole relay.
export function deriveRelayCliSecret(controlSecret: string): string {
  return createHmac('sha256', controlSecret).update('orca-relay-cli-role').digest('hex')
}

export function relayAuthVerifier(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function isRelayAuthSecret(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value)
}

export const isRelayAuthVerifier = isRelayAuthSecret

/**
 * Constant-time check of a presented token against a stored verifier.
 *
 * Why hash first: it makes both operands a fixed 32 bytes, so `timingSafeEqual`
 * never throws on a length mismatch and match time cannot leak how many leading
 * characters of the secret an attacker guessed (cf. orca-daemon token.rs
 * `tokens_match`). No salt: the secret is 256 bits of OS entropy, not a password.
 */
export function relayAuthTokenMatchesVerifier(token: unknown, verifier: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || !isRelayAuthVerifier(verifier)) {
    return false
  }
  return timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(verifier, 'hex'))
}
