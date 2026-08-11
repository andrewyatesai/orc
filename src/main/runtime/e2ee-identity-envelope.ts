/**
 * How this desktop's mobile E2EE identity is sealed on disk, and in what order.
 *
 * Three envelopes, best first:
 *   electron-safe-storage-v1  the OS keychain, bound to this OS user account. Requires a keychain
 *                             that answers, which a headless/SSH host does not have.
 *   operator-passphrase-v1    AES-256-GCM under a scrypt-derived operator passphrase
 *                             (src/main/passphrase-sealed-secret.ts). No keyring, no prompt, works
 *                             headless — and it is real ciphertext, so a copy of the data directory
 *                             is useless without the passphrase.
 *   plaintext                 the last resort. See e2ee-identity-plaintext-fallback.ts for why it
 *                             still exists at all; it is still the DEFAULT on a host that has
 *                             neither of the above, which is why the credential-write report keeps
 *                             classifying the mint site `cleartext-fallback-unfixed`.
 *
 * Both sealed formats are lossless: the same identity comes back, so no paired device is orphaned.
 */
import {
  openPassphraseSealedSecret,
  PassphraseSealedSecretError,
  sealSecretWithPassphrase
} from '../passphrase-sealed-secret'
import { allowsPlaintextE2EEIdentity } from './e2ee-identity-plaintext-fallback'
import { runE2EESecretHelper, type E2EESecretHelperOptions } from './e2ee-secret-unseal-host'

export const KEYPAIR_VERSION = 2

/**
 * Whether a human can answer an OS keychain prompt right now. Unsealing goes through the bounded
 * out-of-process helper in both contexts (there is no alternative — regenerating would silently
 * invalidate every paired device). Sealing has lossless alternatives, so 'headless' reaches for
 * those first rather than spend the helper's timeout budget on a prompt nobody can answer.
 */
export type E2EEKeychainContext = 'interactive' | 'headless'

export type E2EEKeypairResolveOptions = {
  keychainContext?: E2EEKeychainContext
  helper?: E2EESecretHelperOptions
}

type EncryptedKeypairFile = {
  v: 2
  publicKeyB64: string
  secretKeyFormat: 'electron-safe-storage-v1'
  secretKeyCiphertextB64: string
}

type PassphraseKeypairFile = {
  v: 2
  publicKeyB64: string
  secretKeyFormat: 'operator-passphrase-v1'
  secretKeyEnvelope: string
}

/**
 * The reviewed exception: a cleartext-at-rest private key, 0600, written only when neither the
 * keychain nor an operator passphrase can seal it and `allowsPlaintextE2EEIdentity()` permits it.
 * Kept because this key is a durable identity — refusing to persist it orphans every paired device
 * on the next launch rather than costing a re-auth — and upgraded in place as soon as either sealed
 * envelope becomes available.
 */
type PlaintextKeypairFile = {
  v: 2
  publicKeyB64: string
  secretKeyFormat: 'plaintext'
  secretKeyB64: string
}

// Why: pre-encryption files stored the raw secret at { v: 1 }; keep reading them
// so existing pairings survive, then migrate to a sealed envelope on load.
type LegacyKeypairFile = {
  v: 1
  publicKeyB64: string
  secretKeyB64: string
}

export type KeypairFile =
  | EncryptedKeypairFile
  | PassphraseKeypairFile
  | PlaintextKeypairFile
  | LegacyKeypairFile

export type SealedIdentitySecret =
  | {
      secretKeyFormat: 'electron-safe-storage-v1'
      secretKeyCiphertextB64: string
    }
  | { secretKeyFormat: 'operator-passphrase-v1'; secretKeyEnvelope: string }

export type DecodedSecret =
  | { kind: 'ok'; secretKeyB64: string; wasPlaintext: boolean }
  /** Sealed but unopenable right now — the caller must refuse, not regenerate. */
  | { kind: 'unsealable'; message: string }
  /** Unknown format, or bytes that genuinely cannot be opened — regenerate. */
  | { kind: 'undecodable' }

function passphraseEnvelope(secretKeyB64: string): SealedIdentitySecret | null {
  const sealed = sealSecretWithPassphrase(secretKeyB64)
  return sealed ? { secretKeyFormat: 'operator-passphrase-v1', secretKeyEnvelope: sealed } : null
}

/** The best envelope this host can produce right now, or null when it can produce none. */
export async function sealIdentitySecret(
  secretKeyB64: string,
  options: E2EEKeypairResolveOptions
): Promise<SealedIdentitySecret | null> {
  const headless = (options.keychainContext ?? 'interactive') !== 'interactive'
  if (headless) {
    // Why the passphrase comes first here: it seals with no prompt and no child process, so a
    // headless host that has one never pays the keychain's timeout for an unanswerable prompt.
    const sealed = passphraseEnvelope(secretKeyB64)
    if (sealed || allowsPlaintextE2EEIdentity()) {
      return sealed
    }
  }
  const viaKeychain = await runE2EESecretHelper({ op: 'seal', secretKeyB64 }, options.helper)
  if (viaKeychain.ok && viaKeychain.op === 'seal') {
    return {
      secretKeyFormat: 'electron-safe-storage-v1',
      secretKeyCiphertextB64: viaKeychain.ciphertextB64
    }
  }
  // Why the keychain wins on an interactive host: safeStorage is bound to the OS user account,
  // while the passphrase is only as private as the file or environment holding it.
  return passphraseEnvelope(secretKeyB64)
}

export function keypairFileFor(
  publicKeyB64: string,
  sealed: SealedIdentitySecret
): EncryptedKeypairFile | PassphraseKeypairFile {
  return { v: KEYPAIR_VERSION, publicKeyB64, ...sealed }
}

export function plaintextKeypairFile(
  publicKeyB64: string,
  secretKeyB64: string
): PlaintextKeypairFile {
  return {
    v: KEYPAIR_VERSION,
    publicKeyB64,
    secretKeyFormat: 'plaintext',
    secretKeyB64
  }
}

function openPassphraseEnvelope(envelope: string): DecodedSecret {
  try {
    return {
      kind: 'ok',
      secretKeyB64: openPassphraseSealedSecret(envelope),
      wasPlaintext: false
    }
  } catch (error) {
    // Why a missing or wrong passphrase is `unsealable`: the identity on disk is intact and every
    // paired device still works, so this is an operator configuration fault, never a reason to mint.
    const reason = error instanceof PassphraseSealedSecretError ? error.reason : 'malformed'
    return reason === 'malformed'
      ? { kind: 'undecodable' }
      : { kind: 'unsealable', message: (error as Error).message }
  }
}

export async function decodeSecretKeyB64(
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
  if (raw.secretKeyFormat === 'operator-passphrase-v1') {
    return openPassphraseEnvelope(raw.secretKeyEnvelope)
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
