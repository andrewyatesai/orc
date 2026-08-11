import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * Encryption at rest for persisted secrets on hosts that have no usable OS keychain.
 *
 * `allowsPlaintextPersistedSecret` is a DEV opt-in by construction (it refuses in packaged and
 * production builds), so on a packaged headless/SSH Linux host — where Electron's safeStorage
 * reports no backend at all — there was previously no way to persist an integration token: every
 * restart cost a re-authentication. This module is the production-legal path, and it is deliberately
 * NOT a relaxation of that predicate: the bytes it writes are real ciphertext, so the write is not a
 * cleartext write and needs no cleartext opt-in.
 *
 *   envelope := 'orca-passphrase-v1:' base64( version | salt | nonce | gcmTag | ciphertext )
 *   key      := scrypt(operator passphrase, salt, 32 bytes)
 *   cipher   := AES-256-GCM, associated data binding the envelope to this exact format version
 *
 * The passphrase is never written anywhere, never logged, and never derived from anything on disk.
 * What this buys, precisely: a copy of the Orca data directory — a backup, a snapshot, a stolen
 * disk, a stray `scp -r` — is useless without the passphrase. What it does NOT buy: protection from
 * anyone who can already read this process's environment or the passphrase file, which on a
 * single-tenant box is the same user. That is the honest boundary, and it is why the passphrase
 * FILE form is the documented recommendation: an environment variable is inherited by every
 * terminal and agent Orca spawns, while a file read once at startup is not.
 */

// Why two inputs: `_FILE` is the form that keeps the passphrase out of the process environment
// (systemd `LoadCredential=` writes exactly this), and the inline var is the convenience form.
export const SECRET_PASSPHRASE_FILE_ENV = 'ORCA_SECRET_PASSPHRASE_FILE'
export const SECRET_PASSPHRASE_ENV = 'ORCA_SECRET_PASSPHRASE'

export const PASSPHRASE_SECRET_PREFIX = 'orca-passphrase-v1:'

const FORMAT_VERSION = 1
const SALT_BYTES = 16
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const KEY_BYTES = 32
const HEADER_BYTES = 1 + SALT_BYTES + NONCE_BYTES + AUTH_TAG_BYTES

// scrypt N=2^15/r=8/p=1 is ~32MB and ~100ms — the cost the OWASP guidance puts on an interactive
// KDF. maxmem is set explicitly because Node's 32MB default sits exactly on that boundary.
const SCRYPT_COST = 2 ** 15
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const SCRYPT_MAX_MEMORY = 96 * 1024 * 1024

// Why AAD at all: it binds the ciphertext to this format version, so bytes written by a future v2
// envelope can never be opened as v1 even if an attacker rewrites the tag.
const ENVELOPE_ASSOCIATED_DATA = Buffer.from(`${PASSPHRASE_SECRET_PREFIX}${FORMAT_VERSION}`, 'utf8')

export type PassphraseSealFailure = 'no-passphrase' | 'wrong-passphrase' | 'malformed'

export class PassphraseSealedSecretError extends Error {
  readonly reason: PassphraseSealFailure

  constructor(reason: PassphraseSealFailure, message: string) {
    super(message)
    this.name = 'PassphraseSealedSecretError'
    this.reason = reason
  }
}

const NO_PASSPHRASE_MESSAGE =
  `This secret is sealed with an operator passphrase, but neither ${SECRET_PASSPHRASE_FILE_ENV} ` +
  `nor ${SECRET_PASSPHRASE_ENV} is set in this process. Supply the same passphrase this host was ` +
  `configured with, or reconnect the integration to replace the stored secret.`

const WRONG_PASSPHRASE_MESSAGE =
  `This secret is sealed with a different operator passphrase than the one ` +
  `${SECRET_PASSPHRASE_FILE_ENV}/${SECRET_PASSPHRASE_ENV} currently supplies, so it cannot be ` +
  `decrypted. Restore the original passphrase, or reconnect the integration to reseal it.`

let warnedUnreadablePassphraseFile = false

// Why swallow and warn once: an unreadable passphrase file must degrade to "no passphrase" (the
// caller then refuses to persist), not crash a save, and it is re-read on every secret operation.
function readPassphraseFile(filePath: string): string | null {
  let contents: string
  try {
    contents = readFileSync(filePath, 'utf-8')
  } catch (error) {
    if (!warnedUnreadablePassphraseFile) {
      warnedUnreadablePassphraseFile = true
      console.warn(
        `[secret-passphrase] ${SECRET_PASSPHRASE_FILE_ENV} points at ${filePath}, which could not be read; treating the passphrase as unset:`,
        error
      )
    }
    return null
  }
  // Why strip only one trailing newline: `printf`/`echo` and editors add exactly that, while
  // leading and interior whitespace can be a deliberate part of the passphrase.
  const passphrase = contents.replace(/\r?\n$/, '')
  return passphrase.length > 0 ? passphrase : null
}

/** The operator passphrase for this host, or null when none is configured. Never logged. */
export function operatorSecretPassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  const filePath = env[SECRET_PASSPHRASE_FILE_ENV]?.trim()
  if (filePath) {
    return readPassphraseFile(filePath)
  }
  const inline = env[SECRET_PASSPHRASE_ENV]
  return inline ? inline : null
}

export function hasOperatorSecretPassphrase(env: NodeJS.ProcessEnv = process.env): boolean {
  return operatorSecretPassphrase(env) !== null
}

const MAX_CACHED_KEYS = 16
const derivedKeys = new Map<string, Buffer>()

// Why cache: scrypt is deliberately ~100ms, and persistence re-encrypts every secret slot on every
// debounced settings save — without this, a headless host would block the main thread for hundreds
// of ms per save. The cache is keyed by salt so a record written by an earlier process still opens.
function derivedKeyFor(passphrase: string, salt: Buffer): Buffer {
  const cacheKey = `${salt.toString('base64')}:${createHash('sha256').update(passphrase, 'utf-8').digest('base64')}`
  const cached = derivedKeys.get(cacheKey)
  if (cached) {
    return cached
  }
  const key = scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY
  })
  if (derivedKeys.size >= MAX_CACHED_KEYS) {
    derivedKeys.clear()
  }
  derivedKeys.set(cacheKey, key)
  return key
}

let sealSalt: Buffer | null = null

/**
 * One random salt per process for everything this process writes, and a fresh random nonce per
 * record. The salt's job is to make precomputation against this install worthless, which one random
 * 128-bit value already does; a per-record salt would instead force one full scrypt per secret per
 * save, which is a real stall on the low-powered hosts this path exists for and buys an attacker
 * nothing extra. AES-GCM's actual requirement — a nonce never repeated under one key — is met by the
 * per-record nonce.
 */
function saltForSeal(): Buffer {
  sealSalt ??= randomBytes(SALT_BYTES)
  return sealSalt
}

/** The sealed envelope, or null when this host has no operator passphrase configured. */
export function sealSecretWithPassphrase(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const passphrase = operatorSecretPassphrase(env)
  if (passphrase === null) {
    return null
  }
  const salt = saltForSeal()
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', derivedKeyFor(passphrase, salt), nonce)
  cipher.setAAD(ENVELOPE_ASSOCIATED_DATA)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const envelope = Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    salt,
    nonce,
    cipher.getAuthTag(),
    ciphertext
  ])
  return PASSPHRASE_SECRET_PREFIX + envelope.toString('base64')
}

export function isPassphraseSealedSecret(value: string): boolean {
  return value.startsWith(PASSPHRASE_SECRET_PREFIX)
}

/**
 * The plaintext behind a sealed envelope.
 *
 * Throws `PassphraseSealedSecretError` with `reason` distinguishing "you did not give me a
 * passphrase" from "the one you gave me is wrong": callers must be able to tell an operator to fix
 * their configuration apart from telling a user to reconnect, and neither is a corrupt-file case.
 */
export function openPassphraseSealedSecret(
  value: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!isPassphraseSealedSecret(value)) {
    throw new PassphraseSealedSecretError('malformed', 'Not a passphrase-sealed secret.')
  }
  const envelope = Buffer.from(value.slice(PASSPHRASE_SECRET_PREFIX.length), 'base64')
  // `<` not `<=`: an empty secret is a legitimate zero-length ciphertext, and rejecting it here
  // would report a perfectly good envelope as corrupt.
  if (envelope.length < HEADER_BYTES || envelope[0] !== FORMAT_VERSION) {
    throw new PassphraseSealedSecretError(
      'malformed',
      'The passphrase-sealed secret on disk is truncated or has an unsupported format version.'
    )
  }
  const passphrase = operatorSecretPassphrase(env)
  if (passphrase === null) {
    throw new PassphraseSealedSecretError('no-passphrase', NO_PASSPHRASE_MESSAGE)
  }
  const salt = envelope.subarray(1, 1 + SALT_BYTES)
  const nonce = envelope.subarray(1 + SALT_BYTES, 1 + SALT_BYTES + NONCE_BYTES)
  const authTag = envelope.subarray(1 + SALT_BYTES + NONCE_BYTES, HEADER_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', derivedKeyFor(passphrase, salt), nonce)
  decipher.setAAD(ENVELOPE_ASSOCIATED_DATA)
  decipher.setAuthTag(authTag)
  try {
    return Buffer.concat([
      decipher.update(envelope.subarray(HEADER_BYTES)),
      decipher.final()
    ]).toString('utf-8')
  } catch {
    // Why not surface the crypto error: GCM cannot tell a wrong key from tampered bytes, and the
    // message must never quote anything derived from the passphrase or the ciphertext.
    throw new PassphraseSealedSecretError('wrong-passphrase', WRONG_PASSPHRASE_MESSAGE)
  }
}

/** Test seam: clears the per-process salt, the derived-key cache and the warn-once latch. */
export function _resetPassphraseSealStateForTests(): void {
  sealSalt = null
  derivedKeys.clear()
  warnedUnreadablePassphraseFile = false
}
