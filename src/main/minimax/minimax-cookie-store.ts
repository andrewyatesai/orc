import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import {
  openPassphraseSealedSecret,
  PassphraseSealedSecretError,
  sealSecretWithPassphrase,
  SECRET_PASSPHRASE_FILE_ENV
} from '../passphrase-sealed-secret'
import {
  allowsPlaintextPersistedSecret,
  PLAINTEXT_SECRET_OPT_IN_ENV
} from '../plaintext-secret-policy'
import { warnSecretStorageUnavailableOnce } from '../secret-storage-availability'

const MINIMAX_COOKIE_FILE = 'minimax-session-cookie.enc'
const COOKIE_ENVELOPE_PREFIX = 'orca-minimax-cookie:v1:'
let cachedMiniMaxCookie: string | null = null
let warnedMiniMaxCookieStatusHardenFailure = false

// Why four kinds: 'plaintext' is read-only legacy that older builds wrote unconditionally, while
// 'dev-plaintext' is the only cleartext kind we still write and only under the sanctioned opt-in —
// keeping them distinct is what lets a reader tell a leak from a deliberate dev choice.
// 'passphrase' is the keychain-less production path: ciphertext, not cleartext.
type MiniMaxCookieEnvelope = {
  kind: 'encrypted' | 'passphrase' | 'plaintext' | 'dev-plaintext'
  payload: Buffer
}

type MiniMaxCookieRead = {
  cookie: string
  storedAsCleartext: boolean
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getMiniMaxCookiePath(): string {
  return join(getOrcaDir(), MINIMAX_COOKIE_FILE)
}

function encodeCookieEnvelope(kind: MiniMaxCookieEnvelope['kind'], payload: Buffer): string {
  return `${COOKIE_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeCookieEnvelope(raw: Buffer): MiniMaxCookieEnvelope | null {
  const text = raw.toString('utf8')
  if (!text.startsWith(COOKIE_ENVELOPE_PREFIX)) {
    return null
  }
  const rest = text.slice(COOKIE_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator < 0) {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (
    kind !== 'encrypted' &&
    kind !== 'passphrase' &&
    kind !== 'plaintext' &&
    kind !== 'dev-plaintext'
  ) {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

// Why: migrates cookies saved before the envelope format existed. Older files
// hold raw bytes (safeStorage-encrypted or plaintext), so we sniff the content
// to tell the two apart rather than removing this as seemingly dead code.
function looksLikeCookieHeader(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code < 32 || code === 127) {
      return false
    }
  }
  return (
    /^Cookie:\s*\S+/i.test(trimmed) ||
    /(?:^|;\s*)[A-Za-z0-9_.-]+\s*=/.test(trimmed) ||
    /(?:^|[;\s])[A-Za-z0-9_.-]+\s*:\s*["'][^"']+["']/.test(trimmed)
  )
}

function readEnvelope(envelope: MiniMaxCookieEnvelope): MiniMaxCookieRead {
  if (envelope.kind === 'passphrase') {
    // Why let the error out: openPassphraseSealedSecret names the configuration mistake (no
    // passphrase vs. the wrong one), which the generic decrypt message cannot.
    return {
      cookie: openPassphraseSealedSecret(envelope.payload.toString('utf8')),
      storedAsCleartext: false
    }
  }
  if (envelope.kind !== 'encrypted') {
    return { cookie: envelope.payload.toString('utf8'), storedAsCleartext: true }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  return { cookie: safeStorage.decryptString(envelope.payload), storedAsCleartext: false }
}

function readLegacyCleartextCookie(raw: Buffer): MiniMaxCookieRead {
  const plaintext = raw.toString('utf8')
  if (looksLikeCookieHeader(plaintext)) {
    return { cookie: plaintext, storedAsCleartext: true }
  }
  throw new Error('MiniMax session cookie could not be decrypted')
}

function readLegacyCookie(raw: Buffer): MiniMaxCookieRead {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return { cookie: safeStorage.decryptString(raw), storedAsCleartext: false }
    } catch {
      return readLegacyCleartextCookie(raw)
    }
  }
  return readLegacyCleartextCookie(raw)
}

// Why upgrade rather than discard a cleartext cookie already on disk: refusing to read it would
// break usage tracking AND leave the cleartext file sitting there, so rewriting it as ciphertext on
// the first read with a working keychain is the only move that actually removes the exposure.
function upgradeCleartextCookieAtRest(cookie: string): void {
  const keychainAvailable = safeStorage.isEncryptionAvailable()
  const sealed = keychainAvailable ? null : sealSecretWithPassphrase(cookie)
  if (!keychainAvailable && !sealed) {
    console.warn(
      `[minimax] MiniMax session cookie is stored in cleartext on disk; it is re-encrypted automatically once safeStorage is available, or immediately if you set ${SECRET_PASSPHRASE_FILE_ENV} (dev opt-in ${PLAINTEXT_SECRET_OPT_IN_ENV}).`
    )
    return
  }
  try {
    writeSecureFile(
      getMiniMaxCookiePath(),
      // Why the passphrase form counts as an upgrade too: a keychain-less host would otherwise keep
      // the cleartext file forever, which is exactly the exposure this function exists to close.
      sealed
        ? encodeCookieEnvelope('passphrase', Buffer.from(sealed, 'utf8'))
        : encodeCookieEnvelope('encrypted', safeStorage.encryptString(cookie))
    )
  } catch (error) {
    // Why best-effort: the cookie was read successfully, so a failed upgrade must not fail the read.
    console.warn('[minimax] Failed to re-encrypt cleartext MiniMax cookie on read', error)
  }
}

// Throws when the stored cookie cannot be read on this host. Callers check existence first, so the
// refusal path can ask "is this file readable HERE?" without touching the cache it just populated.
function decodeCookieFile(keyPath: string): MiniMaxCookieRead {
  const raw = readFileSync(keyPath)
  const envelope = decodeCookieEnvelope(raw)
  return envelope ? readEnvelope(envelope) : readLegacyCookie(raw)
}

/**
 * Removes an on-disk cookie that a refused save has just superseded.
 *
 * The file is a single envelope, so "keep the ciphertext, drop the cleartext sibling" has no
 * literal equivalent here — readability is the test instead. A cookie this host can still read is
 * one the next launch WILL read, silently authenticating with the credential the user just
 * replaced; a cookie this host cannot read (an `encrypted` envelope with no safeStorage) resurrects
 * nothing and may be the user's only copy, so it stays.
 */
function discardSupersededCookieAtRest(replacement: string): void {
  const keyPath = getMiniMaxCookiePath()
  if (!existsSync(keyPath)) {
    return
  }
  let stored: MiniMaxCookieRead
  try {
    stored = decodeCookieFile(keyPath)
  } catch {
    // Why: unreadable here — it cannot come back, and deleting on a guess would destroy a live cookie.
    return
  }
  // Why the equality check: re-saving an unchanged cookie supersedes nothing, and dropping the file
  // would turn a no-op save into the loss of the only persisted copy.
  if (stored.cookie === replacement) {
    return
  }
  try {
    rmSync(keyPath, { force: true })
  } catch (error) {
    console.warn('[minimax] Failed to remove the superseded MiniMax cookie on disk', error)
    return
  }
  console.warn(
    '[minimax] Removed the superseded MiniMax cookie from disk: it was readable without safeStorage, so the next launch would have used it instead of the cookie you just entered.'
  )
}

export function hasMiniMaxSessionCookie(): boolean {
  // Why: a cookie refused for disk (no safeStorage) still authenticates this process, so the MiniMax
  // usage bar must stay visible — file existence alone would hide a credential that currently works.
  if (cachedMiniMaxCookie !== null) {
    return true
  }
  const keyPath = getMiniMaxCookiePath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedMiniMaxCookieStatusHardenFailure) {
      warnedMiniMaxCookieStatusHardenFailure = true
      console.warn('[minimax] Failed to harden MiniMax cookie file while checking status', error)
    }
  }
  return true
}

export function saveMiniMaxSessionCookie(cookie: string): void {
  const trimmed = cookie.trim()
  if (!trimmed) {
    throw new Error('MiniMax session cookie is required')
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const ciphertext = safeStorage.encryptString(trimmed)
      writeSecureFile(getMiniMaxCookiePath(), encodeCookieEnvelope('encrypted', ciphertext))
      cachedMiniMaxCookie = trimmed
      return
    } catch (error) {
      // Why: an encryptString failure is NOT license to write cleartext — fall through to the same
      // unavailable handling so a transient keychain error can't silently downgrade the cookie.
      console.error('[minimax] Failed to encrypt MiniMax session cookie:', error)
    }
  }
  // Why cache before deciding: the cookie authenticates this process either way, and a MiniMax
  // session cookie is a whole-account bearer credential whose loss costs a re-paste, not a broken
  // flow — so memory-only is the cheap side of the trade in a way a long-lived API token is not.
  cachedMiniMaxCookie = trimmed
  // Why before the cleartext opt-in: this branch writes real ciphertext, so a host with an operator
  // passphrase must never fall through to the plaintext envelope.
  const sealed = sealSecretWithPassphrase(trimmed)
  if (sealed) {
    warnSecretStorageUnavailableOnce('minimax')
    writeSecureFile(
      getMiniMaxCookiePath(),
      encodeCookieEnvelope('passphrase', Buffer.from(sealed, 'utf8'))
    )
    return
  }
  if (!allowsPlaintextPersistedSecret()) {
    console.warn(
      `[minimax] safeStorage unavailable — MiniMax cookie kept in memory only, not written to disk. Set ${SECRET_PASSPHRASE_FILE_ENV} to persist it encrypted with an operator passphrase, or ${PLAINTEXT_SECRET_OPT_IN_ENV}=1 (dev builds) to persist in plaintext.`
    )
    warnSecretStorageUnavailableOnce('minimax')
    discardSupersededCookieAtRest(trimmed)
    // Why throw instead of reporting success: the renderer would otherwise say "saved" for a cookie
    // that vanishes on restart.
    throw new Error(
      'MiniMax session cookie cannot be stored securely: OS encryption (safeStorage) is unavailable. ' +
        'The cookie is active for this session only — unlock your login keyring and save again to persist it, ' +
        `or set ${SECRET_PASSPHRASE_FILE_ENV} to store it encrypted with an operator passphrase.`
    )
  }
  console.warn(
    `[minimax] safeStorage unavailable and ${PLAINTEXT_SECRET_OPT_IN_ENV} opt-in set — storing MiniMax cookie in plaintext`
  )
  writeSecureFile(
    getMiniMaxCookiePath(),
    encodeCookieEnvelope('dev-plaintext', Buffer.from(trimmed, 'utf8'))
  )
}

export function readMiniMaxSessionCookie(): string | null {
  if (cachedMiniMaxCookie !== null) {
    return cachedMiniMaxCookie
  }
  const keyPath = getMiniMaxCookiePath()
  if (!existsSync(keyPath)) {
    return null
  }
  // Why: keep hardening out of the decode/decrypt try below so a chmod/ACL
  // failure isn't misreported as a decrypt failure (matches hasMiniMaxSessionCookie).
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[minimax] Failed to harden MiniMax cookie file while reading', error)
  }
  let read: MiniMaxCookieRead
  try {
    read = decodeCookieFile(keyPath)
  } catch (error) {
    console.error('[minimax] failed to decode/decrypt session cookie', error)
    // Why rethrow this one verbatim: it names the misconfigured passphrase, which the generic
    // message would replace with advice the operator cannot act on.
    if (error instanceof PassphraseSealedSecretError) {
      throw error
    }
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  cachedMiniMaxCookie = read.cookie
  if (read.storedAsCleartext) {
    upgradeCleartextCookieAtRest(read.cookie)
  }
  return cachedMiniMaxCookie
}

export function clearMiniMaxSessionCookie(): void {
  cachedMiniMaxCookie = null
  rmSync(getMiniMaxCookiePath(), { force: true })
}
