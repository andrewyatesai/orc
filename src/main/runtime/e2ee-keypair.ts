// Why: the E2EE keypair enables application-layer encryption between mobile
// and desktop over plain ws://. The public key is embedded in the QR pairing
// offer so the mobile client can derive a shared secret via ECDH.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPair } from '../../shared/e2ee-crypto'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import {
  decodeSecretKeyB64,
  keypairFileFor,
  plaintextKeypairFile,
  sealIdentitySecret,
  type E2EEKeypairResolveOptions,
  type KeypairFile
} from './e2ee-identity-envelope'
import {
  allowsPlaintextE2EEIdentity,
  noticePlaintextE2EEIdentityAtRest,
  SEALED_E2EE_IDENTITY_REQUIRED_MESSAGE,
  warnSealedE2EEIdentityRequired
} from './e2ee-identity-plaintext-fallback'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

// Re-exported so callers keep one import for "the E2EE identity"; the envelope
// module is where the on-disk formats live, not a second public entry point.
export type { E2EEKeychainContext, E2EEKeypairResolveOptions } from './e2ee-identity-envelope'

const KEYPAIR_FILENAME = E2EE_KEYPAIR_FILENAME
const MAX_KEYPAIR_FILE_BYTES = 8 * 1024

export type E2EEKeypair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
  publicKeyB64: string
}

/**
 * Named refusals. A driver must never confuse "I could not look" with "there is nothing there":
 * `unseal_failed` means a sealed identity exists and every paired device is still valid;
 * `identity_unavailable` means no identity exists and none could be created.
 */
export type E2EEIdentityRefusalReason = 'unseal_failed' | 'identity_unavailable'

export type E2EEIdentityResolution =
  | { ok: true; keypair: E2EEKeypair }
  | { ok: false; reason: E2EEIdentityRefusalReason; message: string }

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
        // Whether an upgrade is worth a keychain call is sealIdentitySecret's decision alone, so a
        // headless load still pays nothing while the plaintext fallback is permitted.
        const upgraded = decoded.wasPlaintext
          ? await migratePlaintextEnvelope(
              filePath,
              raw.publicKeyB64,
              decoded.secretKeyB64,
              options
            )
          : false
        if (decoded.wasPlaintext && !upgraded) {
          // Why notice on load too: a host with neither seal never upgrades, so the one mint-time
          // notice would otherwise be the only trace that a cleartext identity key sits here.
          noticePlaintextE2EEIdentityAtRest({
            event: 'loaded',
            filePath,
            keychainContext
          })
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

/** True once the on-disk envelope is sealed; false leaves the cleartext secret in place. */
async function migratePlaintextEnvelope(
  filePath: string,
  publicKeyB64: string,
  secretKeyB64: string,
  options: E2EEKeypairResolveOptions
): Promise<boolean> {
  // Why: upgrade legacy/plaintext-on-disk secrets to a sealed envelope as soon as either the
  // keychain or an operator passphrase can produce one, so at-rest exposure closes without a
  // re-pairing. Best-effort: the loaded keypair is valid either way.
  try {
    const sealed = await sealIdentitySecret(secretKeyB64, options)
    if (sealed) {
      writeSecureJsonFile(filePath, keypairFileFor(publicKeyB64, sealed))
      return true
    }
  } catch {
    // Migration is best-effort; the loaded keypair is still valid.
  }
  return false
}

async function mintKeypair(
  filePath: string,
  options: E2EEKeypairResolveOptions
): Promise<E2EEIdentityResolution> {
  const keypair = generateKeyPair()
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
  const secretKeyB64 = Buffer.from(keypair.secretKey).toString('base64')
  const sealed = await sealIdentitySecret(secretKeyB64, options)
  if (!sealed && !allowsPlaintextE2EEIdentity()) {
    // Why refuse the whole identity and not just the write: an unpersisted identity still pairs
    // devices, then the next launch mints a different one and silently orphans every one of them.
    warnSealedE2EEIdentityRequired()
    return refuse('identity_unavailable', SEALED_E2EE_IDENTITY_REQUIRED_MESSAGE)
  }
  if (!sealed) {
    noticePlaintextE2EEIdentityAtRest({
      event: 'minted',
      filePath,
      keychainContext: options.keychainContext ?? 'interactive'
    })
  }
  try {
    writeSecureJsonFile(
      filePath,
      sealed
        ? keypairFileFor(publicKeyB64, sealed)
        : plaintextKeypairFile(publicKeyB64, secretKeyB64)
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
