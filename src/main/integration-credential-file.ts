import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import {
  credentialDecryptionMessage,
  type IntegrationCredentialService
} from '../shared/integration-credential-errors'
import {
  isPassphraseSealedSecret,
  openPassphraseSealedSecret,
  sealSecretWithPassphrase,
  SECRET_PASSPHRASE_FILE_ENV
} from './passphrase-sealed-secret'
import {
  allowsPlaintextPersistedSecret,
  PLAINTEXT_SECRET_OPT_IN_ENV,
  PLAINTEXT_SECRET_PREFIX
} from './plaintext-secret-policy'
import { warnSecretStorageUnavailableOnce } from './secret-storage-availability'

/**
 * The on-disk contract for Jira/Linear token files, reader and writer together so the tag
 * a write applies is the tag a read understands.
 *
 *   <name>.enc         safeStorage ciphertext, an `orca-passphrase-v1:` envelope, or (from builds
 *                      before this module) bare cleartext
 *   <name>.plaintext   `orca-plaintext-v1:<token>`, written only under the dev opt-in
 *
 * Both `.enc` forms are genuine ciphertext, which is why they share a file name: the reader tells
 * them apart by tag, and neither can be mistaken for the cleartext sibling.
 *
 * When nothing can encrypt, the token is NOT written at all: the caller keeps it in memory so the
 * session stays connected, and the user reconnects after a restart. That is the right trade for
 * these two stores because the credential is re-enterable — the user still has the token.
 */

// Why: connection status treats a token file as a saved credential; empty
// files read as "missing", so counting them would split-brain getStatus.
function fileHasContent(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

export class CredentialDecryptionError extends Error {
  // Why the appended detail: `isIntegrationCredentialDecryptionError` matches the canonical message
  // with `includes`, so extra text survives IPC without breaking detection — and a passphrase
  // failure needs to say WHICH configuration is wrong, not just "could not decrypt".
  constructor(service: IntegrationCredentialService, detail?: string) {
    super(
      detail
        ? `${credentialDecryptionMessage(service)} ${detail}`
        : credentialDecryptionMessage(service)
    )
    this.name = 'CredentialDecryptionError'
  }
}

export type CredentialPersistOutcome =
  | 'encrypted'
  | 'passphrase-encrypted'
  | 'plaintext-opt-in'
  | 'memory-only'

const ENCRYPTED_CREDENTIAL_SUFFIX = '.enc'
const PLAINTEXT_CREDENTIAL_SUFFIX = '.plaintext'

// Why: cleartext must never sit in a file named `.enc`; the sibling name says what the bytes are
// before anyone opens them. Suffix surgery only, so it is identical on every platform.
export function plaintextCredentialPath(encryptedPath: string): string {
  const base = encryptedPath.endsWith(ENCRYPTED_CREDENTIAL_SUFFIX)
    ? encryptedPath.slice(0, -ENCRYPTED_CREDENTIAL_SUFFIX.length)
    : encryptedPath
  return `${base}${PLAINTEXT_CREDENTIAL_SUFFIX}`
}

export function storedCredentialExists(encryptedPath: string): boolean {
  return fileHasContent(encryptedPath) || fileHasContent(plaintextCredentialPath(encryptedPath))
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // File may not exist — safe to ignore.
  }
}

export function removeStoredCredentialToken(encryptedPath: string): void {
  unlinkIfPresent(encryptedPath)
  unlinkIfPresent(plaintextCredentialPath(encryptedPath))
}

function logTag(service: IntegrationCredentialService): string {
  return service.toLowerCase()
}

// Returns ciphertext, or null when encryption is unavailable OR failed. Why null on failure: an
// encryptString error is NOT license to write cleartext, so it takes the same path as no keychain.
function encryptCredential(service: IntegrationCredentialService, token: string): Buffer | null {
  if (!safeStorage.isEncryptionAvailable()) {
    return null
  }
  try {
    return safeStorage.encryptString(token)
  } catch (error) {
    console.error(
      `[${logTag(service)}] safeStorage encryption failed — refusing to fall back to cleartext:`,
      error
    )
    return null
  }
}

/**
 * Persists `token` for `service`, or refuses. The caller must still hold the token in memory:
 * a 'memory-only' result means nothing was written and the session is the only copy.
 */
export function writeStoredCredentialToken(
  service: IntegrationCredentialService,
  encryptedPath: string,
  token: string
): CredentialPersistOutcome {
  const ciphertext = encryptCredential(service, token)
  if (ciphertext) {
    writeFileSync(encryptedPath, ciphertext, { mode: 0o600 })
    // Why: a cleartext sibling left from an earlier fallback would outlive the encrypted token.
    unlinkIfPresent(plaintextCredentialPath(encryptedPath))
    return 'encrypted'
  }

  // Why before the dev opt-in and not after: on a host with a passphrase configured this branch
  // produces real ciphertext, so the cleartext branch must never be reached there at all.
  const sealed = sealSecretWithPassphrase(token)
  if (sealed) {
    warnSecretStorageUnavailableOnce(logTag(service))
    writeFileSync(encryptedPath, sealed, { encoding: 'utf-8', mode: 0o600 })
    unlinkIfPresent(plaintextCredentialPath(encryptedPath))
    return 'passphrase-encrypted'
  }

  if (allowsPlaintextPersistedSecret()) {
    console.warn(
      `[${logTag(service)}] safeStorage unavailable — persisting the ${service} token in plaintext (dev opt-in ${PLAINTEXT_SECRET_OPT_IN_ENV}).`
    )
    writeFileSync(plaintextCredentialPath(encryptedPath), PLAINTEXT_SECRET_PREFIX + token, {
      encoding: 'utf-8',
      mode: 0o600
    })
    unlinkIfPresent(encryptedPath)
    return 'plaintext-opt-in'
  }

  // Why only the plaintext sibling: it is readable on THIS host, so leaving it would silently
  // reconnect a superseded credential. The ciphertext cannot be read here at all (that is why we
  // are in this branch), so it resurrects nothing — and deleting it would destroy the user's only
  // copy of a still-valid token the moment a keychain-less launch re-saved an unchanged value.
  unlinkIfPresent(plaintextCredentialPath(encryptedPath))
  const keptCiphertext = fileHasContent(encryptedPath)
  const nextStep = keptCiphertext
    ? `A previously encrypted ${service} token is still on disk and will be used again once it can be decrypted here; reconnect ${service} to replace it.`
    : `Reconnect ${service} after restarting Orca, set ${SECRET_PASSPHRASE_FILE_ENV} to persist it encrypted with an operator passphrase, or set ${PLAINTEXT_SECRET_OPT_IN_ENV}=1 in a dev build to persist it in plaintext.`
  console.warn(
    `[${logTag(service)}] safeStorage unavailable — the ${service} token is kept in memory for this session only and was NOT written to disk. ${nextStep}`
  )
  warnSecretStorageUnavailableOnce(logTag(service))
  return 'memory-only'
}

type StoredCredentialForm = 'ciphertext' | 'plaintext'

type StoredCredentialRead = {
  token: string | null
  form: StoredCredentialForm
}

function usableToken(token: string): string | null {
  return token.length > 0 ? token : null
}

function decodeUtf8(raw: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return null
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function readPlaintextLegacyCredential(
  service: IntegrationCredentialService,
  raw: Buffer
): string | null {
  const plaintext = decodeUtf8(raw)
  // Why: legacy plaintext tokens are printable UTF-8; safeStorage ciphertext
  // such as macOS v10 blobs must not be decoded into auth-header junk.
  if (plaintext === null || hasControlCharacter(plaintext)) {
    throw new CredentialDecryptionError(service)
  }
  return usableToken(plaintext)
}

// Returns null when these bytes are not a passphrase envelope at all; throws when they are one this
// host cannot open, because silently falling through would hand the caller the envelope as a token.
function passphraseSealedCredential(
  service: IntegrationCredentialService,
  raw: Buffer
): string | null {
  const decoded = decodeUtf8(raw)
  if (decoded === null || !isPassphraseSealedSecret(decoded)) {
    return null
  }
  try {
    return openPassphraseSealedSecret(decoded)
  } catch (error) {
    throw new CredentialDecryptionError(service, error instanceof Error ? error.message : undefined)
  }
}

// Why the tag is checked before decryptString: an opted-in plaintext blob is not ciphertext, and
// letting decrypt fail first would fall through to the legacy reader and hand back the tag too.
function taggedPlaintext(raw: Buffer): string | null {
  const decoded = decodeUtf8(raw)
  if (decoded === null || !decoded.startsWith(PLAINTEXT_SECRET_PREFIX)) {
    return null
  }
  return decoded.slice(PLAINTEXT_SECRET_PREFIX.length)
}

/**
 * Reads the stored token, null when the file is empty, and throws CredentialDecryptionError when
 * the file holds ciphertext we cannot decrypt (e.g. the user denied the OS keychain prompt after
 * an app re-sign). `form` tells the caller whether the bytes on disk were cleartext.
 */
export function readStoredCredentialToken(
  service: IntegrationCredentialService,
  raw: Buffer
): StoredCredentialRead {
  if (raw.length === 0) {
    return { token: null, form: 'plaintext' }
  }

  const passphraseSealed = passphraseSealedCredential(service, raw)
  if (passphraseSealed !== null) {
    // form 'ciphertext' on purpose: this is real ciphertext, so the caller must not try to
    // "upgrade" it to safeStorage and must not treat it as an at-rest exposure.
    return { token: usableToken(passphraseSealed), form: 'ciphertext' }
  }

  const tagged = taggedPlaintext(raw)
  if (tagged !== null) {
    return { token: usableToken(tagged), form: 'plaintext' }
  }

  if (safeStorage.isEncryptionAvailable()) {
    try {
      return { token: usableToken(safeStorage.decryptString(raw)), form: 'ciphertext' }
    } catch {
      return { token: readPlaintextLegacyCredential(service, raw), form: 'plaintext' }
    }
  }

  return { token: readPlaintextLegacyCredential(service, raw), form: 'plaintext' }
}

// Why best-effort: a keychain that came back is the only chance to retire cleartext an older build
// left at rest, but the token just recovered is valid whether or not the rewrite lands.
function upgradeStoredCredentialToCiphertext(
  service: IntegrationCredentialService,
  encryptedPath: string,
  readPath: string,
  token: string
): void {
  // Why the passphrase is tried here too: encryptCredential only speaks safeStorage, so on a
  // keychain-less host this bailed and a cleartext token left by an older build stayed on disk
  // forever — even once an operator had configured a passphrase that could seal it right now.
  // Retiring cleartext at rest is the entire point of this function.
  const ciphertext = encryptCredential(service, token)
  const sealed = ciphertext ?? sealSecretWithPassphrase(token)
  if (!sealed) {
    return
  }
  try {
    writeFileSync(
      encryptedPath,
      sealed,
      typeof sealed === 'string' ? { encoding: 'utf-8', mode: 0o600 } : { mode: 0o600 }
    )
  } catch (error) {
    console.warn(`[${logTag(service)}] could not re-encrypt the stored credential:`, error)
    return
  }
  if (readPath !== encryptedPath) {
    unlinkIfPresent(readPath)
  }
}

/**
 * Reads the token file for `service`, upgrading a cleartext one to ciphertext the first time a
 * keychain is available again. Returns null when no token file exists.
 */
export function readStoredCredentialTokenFile(
  service: IntegrationCredentialService,
  encryptedPath: string
): string | null {
  const readPath = existsSync(encryptedPath)
    ? encryptedPath
    : plaintextCredentialPath(encryptedPath)
  if (!existsSync(readPath)) {
    return null
  }
  const { token, form } = readStoredCredentialToken(service, readFileSync(readPath))
  if (token !== null && form === 'plaintext') {
    upgradeStoredCredentialToCiphertext(service, encryptedPath, readPath, token)
  }
  return token
}
