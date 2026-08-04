// Why: the E2EE keypair enables application-layer encryption between mobile
// and desktop over plain ws://. The public key is embedded in the QR pairing
// offer so the mobile client can derive a shared secret via ECDH.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPair } from '../../shared/e2ee-crypto'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import {
  runE2EESecretHelper,
  type E2EESecretHelperOptions,
  type E2EESecretHelperResult
} from './e2ee-secret-unseal-host'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

const KEYPAIR_FILENAME = E2EE_KEYPAIR_FILENAME
const KEYPAIR_VERSION = 2
const MAX_KEYPAIR_FILE_BYTES = 8 * 1024

// Why: the secret half is this desktop's sole confidentiality anchor for all
// mobile E2EE, so wrap it in the OS keychain (mirroring the cloud-session
// store) rather than persisting the raw base64 that 0600 alone protected.
type EncryptedKeypairFile = {
  v: 2
  publicKeyB64: string
  secretKeyFormat: 'electron-safe-storage-v1'
  secretKeyCiphertextB64: string
}

type PlaintextKeypairFile = {
  v: 2
  publicKeyB64: string
  secretKeyFormat: 'plaintext'
  secretKeyB64: string
}

// Why: pre-encryption files stored the raw secret at { v: 1 }; keep reading them
// so existing pairings survive, then migrate to the encrypted envelope on load.
type LegacyKeypairFile = {
  v: 1
  publicKeyB64: string
  secretKeyB64: string
}

type KeypairFile = EncryptedKeypairFile | PlaintextKeypairFile | LegacyKeypairFile

export type E2EEKeypair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
  publicKeyB64: string
}

/**
 * Whether a human can answer an OS keychain prompt right now. Unsealing goes through the bounded
 * out-of-process helper in both contexts (there is no alternative — regenerating would silently
 * invalidate every paired device). Sealing does have a lossless alternative (a 0600 plaintext
 * envelope, upgraded on the next interactive load), so 'headless' skips it rather than spend the
 * helper's timeout budget on a prompt nobody can answer.
 */
export type E2EEKeychainContext = 'interactive' | 'headless'

/**
 * Named refusals. A driver must never confuse "I could not look" with "there is nothing there":
 * `unseal_failed` means a sealed identity exists and every paired device is still valid;
 * `identity_unavailable` means no identity exists and none could be created.
 */
export type E2EEIdentityRefusalReason = 'unseal_failed' | 'identity_unavailable'

export type E2EEIdentityResolution =
  | { ok: true; keypair: E2EEKeypair }
  | { ok: false; reason: E2EEIdentityRefusalReason; message: string }

export type E2EEKeypairResolveOptions = {
  keychainContext?: E2EEKeychainContext
  helper?: E2EESecretHelperOptions
}

function refuse(reason: E2EEIdentityRefusalReason, detail: unknown): E2EEIdentityResolution {
  const message = detail instanceof Error ? detail.message : String(detail)
  return { ok: false, reason, message }
}

export async function resolveE2EEIdentity(
  userDataPath: string,
  options: E2EEKeypairResolveOptions = {}
): Promise<E2EEIdentityResolution> {
  const keychainContext = options.keychainContext ?? 'interactive'
  const filePath = join(userDataPath, KEYPAIR_FILENAME)

  const raw = readKeypairFile(filePath)
  if (raw?.publicKeyB64) {
    const decoded = await decodeSecretKeyB64(raw, options)
    if (decoded.kind === 'unsealable') {
      // Never regenerate here: the sealed identity is intact and every paired device still works.
      return { ok: false, reason: 'unseal_failed', message: decoded.message }
    }
    if (decoded.kind === 'ok') {
      const keypair = toKeypair(raw.publicKeyB64, decoded.secretKeyB64)
      if (keypair) {
        if (decoded.wasPlaintext && keychainContext === 'interactive') {
          await migratePlaintextEnvelope(filePath, raw.publicKeyB64, decoded.secretKeyB64, options)
        }
        return { ok: true, keypair }
      }
    }
  }

  return await mintKeypair(filePath, options)
}

function toKeypair(publicKeyB64: string, secretKeyB64: string): E2EEKeypair | null {
  const publicKey = Uint8Array.from(Buffer.from(publicKeyB64, 'base64'))
  const secretKey = Uint8Array.from(Buffer.from(secretKeyB64, 'base64'))
  return publicKey.length === 32 && secretKey.length === 32
    ? { publicKey, secretKey, publicKeyB64 }
    : null
}

type DecodedSecret =
  | { kind: 'ok'; secretKeyB64: string; wasPlaintext: boolean }
  /** Sealed but unopenable right now — the caller must refuse, not regenerate. */
  | { kind: 'unsealable'; message: string }
  /** Unknown format, or a keychain that genuinely cannot decrypt this ciphertext — regenerate. */
  | { kind: 'undecodable' }

async function decodeSecretKeyB64(
  raw: KeypairFile,
  options: E2EEKeypairResolveOptions
): Promise<DecodedSecret> {
  if (raw.v === 1) {
    return { kind: 'ok', secretKeyB64: raw.secretKeyB64, wasPlaintext: true }
  }
  if (raw.v !== KEYPAIR_VERSION) {
    return { kind: 'undecodable' }
  }
  if (raw.secretKeyFormat === 'plaintext') {
    return { kind: 'ok', secretKeyB64: raw.secretKeyB64, wasPlaintext: true }
  }
  if (raw.secretKeyFormat !== 'electron-safe-storage-v1') {
    return { kind: 'undecodable' }
  }
  const unsealed = await runE2EESecretHelper(
    { op: 'unseal', ciphertextB64: raw.secretKeyCiphertextB64 },
    options.helper
  )
  if (unsealed.ok && unsealed.op === 'unseal') {
    return {
      kind: 'ok',
      secretKeyB64: unsealed.secretKeyB64,
      wasPlaintext: false
    }
  }
  // Why: a helper that never answered says nothing about the ciphertext, so treating it as
  // corrupt would burn every pairing on a transient keychain stall.
  return unsealed.ok || unsealed.reason === 'timeout' || unsealed.reason === 'helper_unavailable'
    ? {
        kind: 'unsealable',
        message: unsealed.ok ? 'Unexpected helper reply.' : unsealed.message
      }
    : { kind: 'undecodable' }
}

async function sealSecretKeyB64(
  secretKeyB64: string,
  options: E2EEKeypairResolveOptions
): Promise<string | null> {
  // Why: minting/migration have a lossless fallback (0600 plaintext, upgraded on the next
  // interactive load), so a headless launch never spends the helper budget on an unanswerable prompt.
  if ((options.keychainContext ?? 'interactive') !== 'interactive') {
    return null
  }
  const sealed: E2EESecretHelperResult = await runE2EESecretHelper(
    { op: 'seal', secretKeyB64 },
    options.helper
  )
  return sealed.ok && sealed.op === 'seal' ? sealed.ciphertextB64 : null
}

async function migratePlaintextEnvelope(
  filePath: string,
  publicKeyB64: string,
  secretKeyB64: string,
  options: E2EEKeypairResolveOptions
): Promise<void> {
  // Why: upgrade legacy/plaintext-on-disk secrets to the encrypted envelope once the keychain
  // answers, so at-rest exposure closes. Best-effort: the loaded keypair is valid either way.
  try {
    const ciphertextB64 = await sealSecretKeyB64(secretKeyB64, options)
    if (ciphertextB64) {
      writeSecureJsonFile(filePath, {
        v: KEYPAIR_VERSION,
        publicKeyB64,
        secretKeyFormat: 'electron-safe-storage-v1',
        secretKeyCiphertextB64: ciphertextB64
      } satisfies EncryptedKeypairFile)
    }
  } catch {
    // Migration is best-effort; the loaded keypair is still valid.
  }
}

async function mintKeypair(
  filePath: string,
  options: E2EEKeypairResolveOptions
): Promise<E2EEIdentityResolution> {
  const keypair = generateKeyPair()
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
  const secretKeyB64 = Buffer.from(keypair.secretKey).toString('base64')
  const ciphertextB64 = await sealSecretKeyB64(secretKeyB64, options)
  try {
    writeSecureJsonFile(
      filePath,
      ciphertextB64
        ? ({
            v: KEYPAIR_VERSION,
            publicKeyB64,
            secretKeyFormat: 'electron-safe-storage-v1',
            secretKeyCiphertextB64: ciphertextB64
          } satisfies EncryptedKeypairFile)
        : ({
            v: KEYPAIR_VERSION,
            publicKeyB64,
            secretKeyFormat: 'plaintext',
            secretKeyB64
          } satisfies PlaintextKeypairFile)
    )
  } catch (error) {
    return refuse('identity_unavailable', error)
  }
  return { ok: true, keypair: { ...keypair, publicKeyB64 } }
}

function readKeypairFile(filePath: string): KeypairFile | null {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    hardenExistingSecureFile(filePath)
    // Why: this read is synchronous; valid keypair files are tiny, so
    // oversized/corrupt files should be replaced without loading.
    if (statSync(filePath).size > MAX_KEYPAIR_FILE_BYTES) {
      return null
    }
    return JSON.parse(readFileSync(filePath, 'utf-8')) as KeypairFile
  } catch {
    return null
  }
}
