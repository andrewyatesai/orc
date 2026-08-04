/**
 * The child half of the keychain seam. `safeStorage` is synchronous, main-process-only, and on
 * macOS blocks inside the run loop forever when the requesting binary's code identity misses the
 * keychain item's ACL — no timer, microtask or IPC can run, so an in-process timeout cannot exist.
 * Doing it here, in a disposable Electron child, makes SIGKILL the timeout.
 *
 * Entered through out/main/bootstrap.js (a packaged Electron binary ignores a script path in argv),
 * which dispatches on E2EE_SECRET_HELPER_ENV_FLAG so this never loads the app bundle.
 */
import { writeSync } from 'node:fs'
import { app, safeStorage } from 'electron'
import {
  encodeE2EESecretHelperReply,
  type E2EESecretHelperReply,
  type E2EESecretHelperRequest
} from './e2ee-secret-unseal-protocol'

const MAX_REQUEST_BYTES = 64 * 1024

function readRequest(): Promise<E2EESecretHelperRequest | null> {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > MAX_REQUEST_BYTES) {
        resolve(null)
      }
    })
    process.stdin.on('error', () => resolve(null))
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(raw) as E2EESecretHelperRequest
        resolve(parsed?.op === 'seal' || parsed?.op === 'unseal' ? parsed : null)
      } catch {
        resolve(null)
      }
    })
  })
}

function perform(request: E2EESecretHelperRequest): E2EESecretHelperReply {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      reason: 'encryption_unavailable',
      message: 'OS encryption is not available on this host.'
    }
  }
  if (request.op === 'seal') {
    return {
      ok: true,
      op: 'seal',
      ciphertextB64: safeStorage.encryptString(request.secretKeyB64).toString('base64')
    }
  }
  return {
    ok: true,
    op: 'unseal',
    secretKeyB64: safeStorage.decryptString(Buffer.from(request.ciphertextB64, 'base64'))
  }
}

async function runE2EESecretHelperChild(): Promise<void> {
  // Why: a keychain oracle needs no GPU and must not bounce the dock on every pairing offer.
  app.disableHardwareAcceleration()
  app.dock?.hide()

  const request = await readRequest()
  if (!request) {
    app.exit(2)
    return
  }
  // Why: on Linux the keyring backend is only wired up once the app is ready.
  await app.whenReady()

  let reply: E2EESecretHelperReply
  try {
    reply = perform(request)
  } catch (error) {
    reply = {
      ok: false,
      reason: 'keychain_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
  // Never logged, never written to a file: the plaintext secret leaves only through this pipe.
  // writeSync, because process.stdout to a pipe is async on POSIX and app.exit would truncate it.
  writeSync(1, encodeE2EESecretHelperReply(reply))
  app.exit(0)
}

void runE2EESecretHelperChild()
