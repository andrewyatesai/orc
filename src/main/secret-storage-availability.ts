import { safeStorage } from 'electron'
import { hasOperatorSecretPassphrase, SECRET_PASSPHRASE_FILE_ENV } from './passphrase-sealed-secret'

/**
 * Why safeStorage said no, and what the operator can actually do about it.
 *
 * Electron 43's own typings state the mechanism (node_modules/electron/electron.d.ts, SafeStorage):
 * `isEncryptionAvailable()` on Linux is true only once the app is ready AND "the secret key is
 * available", and `getSelectedStorageBackend()` returns `basic_text` "when the desktop environment
 * is not recognised". A headless or SSH host has no recognised desktop, no D-Bus session bus and
 * usually no gnome-keyring/kwallet at all, so Chromium selects `basic_text`, no secret key is ever
 * fetched, and `isEncryptionAvailable()` is false. A host that DOES have a keyring backend selected
 * but keeps it locked, or cannot reach the session bus, fails the same check for a different reason
 * and needs different advice — which is the whole point of reporting the backend name.
 *
 * Deliberately NOT offered: `safeStorage.setUsePlainTextEncryption(true)` / `--password-store=basic`.
 * That makes `isEncryptionAvailable()` return true by encrypting with a hardcoded in-memory
 * password, so every store in this process — and this report — would believe the secret was
 * protected. Cleartext that lies about itself is worse than cleartext, so Orca never enables it.
 */

export type LinuxSecretStorageBackend =
  | 'basic_text'
  | 'gnome_libsecret'
  | 'kwallet'
  | 'kwallet5'
  | 'kwallet6'
  | 'unknown'

export type SecretStorageDiagnosis = {
  encryptionAvailable: boolean
  platform: NodeJS.Platform
  /** null off Linux, or when the running Electron does not expose the backend name. */
  linuxBackend: LinuxSecretStorageBackend | null
  hasDbusSession: boolean
  passphraseConfigured: boolean
}

function readEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

// Why the typeof guard: getSelectedStorageBackend is Linux-only and throws before `ready`, and this
// runs in CLI/serve entry points that may call it early.
function readLinuxBackend(platform: NodeJS.Platform): LinuxSecretStorageBackend | null {
  if (platform !== 'linux' || typeof safeStorage.getSelectedStorageBackend !== 'function') {
    return null
  }
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return null
  }
}

export function diagnoseSecretStorage(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): SecretStorageDiagnosis {
  return {
    encryptionAvailable: readEncryptionAvailable(),
    platform,
    linuxBackend: readLinuxBackend(platform),
    hasDbusSession: Boolean(env.DBUS_SESSION_BUS_ADDRESS),
    passphraseConfigured: hasOperatorSecretPassphrase(env)
  }
}

const PASSPHRASE_REMEDY =
  `set ${SECRET_PASSPHRASE_FILE_ENV} to a file holding an operator passphrase — stored secrets are ` +
  `then encrypted with AES-256-GCM under a scrypt-derived key, with no OS keyring involved`

function keyringRemedy(diagnosis: SecretStorageDiagnosis): string {
  if (diagnosis.platform !== 'linux') {
    return 'unlock the OS keychain for the account this process runs as'
  }
  if (diagnosis.linuxBackend === 'basic_text' || diagnosis.linuxBackend === null) {
    return (
      'give this host a real keyring (install gnome-keyring and libsecret, run it under a D-Bus ' +
      'session, unlock it with `gnome-keyring-daemon --unlock`, and export DBUS_SESSION_BUS_ADDRESS ' +
      'to the Orca process), then launch with `--password-store=gnome-libsecret`'
    )
  }
  return (
    `unlock the ${diagnosis.linuxBackend} keyring for this account and make sure the Orca process ` +
    `can reach the session bus`
  )
}

function backendDetail(diagnosis: SecretStorageDiagnosis): string {
  if (diagnosis.linuxBackend === null) {
    return ''
  }
  const bus = diagnosis.hasDbusSession
    ? 'DBUS_SESSION_BUS_ADDRESS is set'
    : 'DBUS_SESSION_BUS_ADDRESS is unset'
  return ` (safeStorage backend: ${diagnosis.linuxBackend}; ${bus})`
}

/** One sentence an operator can act on, tailored to why this host has no keychain. */
export function secretStorageRemedy(
  diagnosis: SecretStorageDiagnosis = diagnoseSecretStorage()
): string {
  if (diagnosis.passphraseConfigured) {
    return (
      `No OS keychain is available${backendDetail(diagnosis)}, so stored secrets are sealed with the ` +
      `operator passphrase instead. To use the OS keychain instead, ${keyringRemedy(diagnosis)}.`
    )
  }
  return (
    `No OS keychain is available${backendDetail(diagnosis)}, so secrets cannot be persisted on this ` +
    `host. Either ${keyringRemedy(diagnosis)}, or ${PASSPHRASE_REMEDY}. Do not pass ` +
    `--password-store=basic: its key is a hardcoded constant, so it is cleartext with extra steps. ` +
    `See docs/reference/headless-linux-server.md.`
  )
}

let warnedSecretStorageUnavailable = false

/**
 * Logs the diagnosis once per process. Once, because every store hits this on every save and the
 * answer cannot change mid-process — a per-write warning would bury the one line that matters.
 */
export function warnSecretStorageUnavailableOnce(logTag: string): void {
  if (warnedSecretStorageUnavailable) {
    return
  }
  warnedSecretStorageUnavailable = true
  console.warn(`[${logTag}] ${secretStorageRemedy()}`)
}

/** Test seam: re-arms the warn-once latch. */
export function _resetSecretStorageWarningForTests(): void {
  warnedSecretStorageUnavailable = false
}
