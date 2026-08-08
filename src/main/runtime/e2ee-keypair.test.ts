import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'
import {
  allowsPlaintextE2EEIdentity,
  REQUIRE_SEALED_E2EE_IDENTITY_ENV
} from './e2ee-identity-plaintext-fallback'
import type { E2EESecretHelperResult } from './e2ee-secret-unseal-host'
import type { E2EESecretHelperRequest } from './e2ee-secret-unseal-protocol'

// Why: every keychain call now happens in a child Electron process (see e2ee-secret-unseal-host);
// standing in for that child is the only seam this module has left, and it is also the seam that
// pins the invariant — nothing here may import `electron` or call safeStorage in-process.
const helperControl = vi.hoisted(() => ({
  answer: null as ((request: E2EESecretHelperRequest) => E2EESecretHelperResult) | null
}))

const runHelper = vi.hoisted(() => vi.fn())

vi.mock('./e2ee-secret-unseal-host', () => ({
  runE2EESecretHelper: (request: E2EESecretHelperRequest) => {
    runHelper(request)
    return Promise.resolve(
      helperControl.answer?.(request) ?? {
        ok: false,
        reason: 'helper_unavailable',
        message: 'no helper'
      }
    )
  }
}))

/** The child on a healthy host: safeStorage answers immediately. */
function workingKeychain(request: E2EESecretHelperRequest): E2EESecretHelperResult {
  return request.op === 'seal'
    ? {
        ok: true,
        op: 'seal',
        ciphertextB64: Buffer.from(`enc:${request.secretKeyB64}`, 'utf-8').toString('base64')
      }
    : {
        ok: true,
        op: 'unseal',
        secretKeyB64: Buffer.from(request.ciphertextB64, 'base64')
          .toString('utf-8')
          .replace(/^enc:/, '')
      }
}

/** The shipped wedge: the helper was killed because the OS keychain never answered. */
function wedgedKeychain(): E2EESecretHelperResult {
  return {
    ok: false,
    reason: 'timeout',
    message: 'The OS keychain did not answer within 5000ms'
  }
}

async function loadModule() {
  vi.resetModules()
  return import('./e2ee-keypair')
}

/** The headless Linux host this fork targets: no keyring, so the child can never seal. */
function keychainlessHost(): E2EESecretHelperResult {
  return { ok: false, reason: 'encryption_unavailable', message: 'no OS encryption' }
}

let dir = ''
let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2ee-keypair-'))
  helperControl.answer = workingKeychain
  runHelper.mockClear()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env[REQUIRE_SEALED_E2EE_IDENTITY_ENV]
  warn.mockRestore()
})

const warnedText = () => warn.mock.calls.map((call) => String(call[0])).join('\n')

const filePath = () => join(dir, E2EE_KEYPAIR_FILENAME)
const readFile = () => JSON.parse(readFileSync(filePath(), 'utf-8'))

async function requireKeypair(userDataPath: string, keychainContext?: 'interactive' | 'headless') {
  const { resolveE2EEIdentity } = await loadModule()
  const resolution = await resolveE2EEIdentity(userDataPath, {
    keychainContext
  })
  if (!resolution.ok) {
    throw new Error(`${resolution.reason}: ${resolution.message}`)
  }
  return resolution.keypair
}

describe('resolveE2EEIdentity', () => {
  it('persists a new secret encrypted at rest, never as raw base64', async () => {
    const kp = await requireKeypair(dir)
    const onDisk = readFile()
    expect(onDisk.v).toBe(2)
    expect(onDisk.secretKeyFormat).toBe('electron-safe-storage-v1')
    expect(onDisk.secretKeyCiphertextB64).toBeTruthy()
    // Revert guard: the raw secret must not appear anywhere in the file.
    const rawSecretB64 = Buffer.from(kp.secretKey).toString('base64')
    expect(readFileSync(filePath(), 'utf-8')).not.toContain(rawSecretB64)
    expect('secretKeyB64' in onDisk).toBe(false)
  })

  it('round-trips: a reload returns the identical keypair via the unseal helper', async () => {
    const first = await requireKeypair(dir)
    runHelper.mockClear()
    const second = await requireKeypair(dir)
    expect(Buffer.from(second.secretKey).toString('base64')).toBe(
      Buffer.from(first.secretKey).toString('base64')
    )
    expect(second.publicKeyB64).toBe(first.publicKeyB64)
    expect(runHelper).toHaveBeenCalledWith(expect.objectContaining({ op: 'unseal' }))
  })

  it('falls back to a plaintext envelope only when the keychain cannot seal', async () => {
    helperControl.answer = () => ({
      ok: false,
      reason: 'encryption_unavailable',
      message: 'no OS encryption'
    })
    await requireKeypair(dir)
    expect(readFile().secretKeyFormat).toBe('plaintext')
  })

  it('migrates a legacy v1 plaintext file to the encrypted envelope on load', async () => {
    const seeded = await requireKeypair(dir)
    const secretKeyB64 = Buffer.from(seeded.secretKey).toString('base64')
    writeFileSync(
      filePath(),
      JSON.stringify({ v: 1, publicKeyB64: seeded.publicKeyB64, secretKeyB64 })
    )

    const loaded = await requireKeypair(dir)
    // Same keys recovered...
    expect(Buffer.from(loaded.secretKey).toString('base64')).toBe(secretKeyB64)
    // ...and the on-disk file was upgraded to the encrypted envelope.
    const onDisk = readFile()
    expect(onDisk.v).toBe(2)
    expect(onDisk.secretKeyFormat).toBe('electron-safe-storage-v1')
    expect(readFileSync(filePath(), 'utf-8')).not.toContain(secretKeyB64)
  })

  it('regenerates when the keychain reports it genuinely cannot decrypt the envelope', async () => {
    const first = await requireKeypair(dir)
    const firstSecret = Buffer.from(first.secretKey).toString('base64')

    // Keychain rotation / restored profile: the ciphertext is real garbage now.
    helperControl.answer = () => ({
      ok: false,
      reason: 'keychain_error',
      message: 'decryption failed'
    })
    const regenerated = await requireKeypair(dir)
    expect(Buffer.from(regenerated.secretKey).toString('base64')).not.toBe(firstSecret)
    expect(regenerated.secretKey.length).toBe(32)
  })

  it('refuses with unseal_failed — and keeps the sealed file — when the helper is killed', async () => {
    const sealed = await requireKeypair(dir)
    const onDiskBefore = readFileSync(filePath(), 'utf-8')

    helperControl.answer = wedgedKeychain
    const { resolveE2EEIdentity } = await loadModule()
    const resolution = await resolveE2EEIdentity(dir)

    // The distinction a driver must never lose: "I could not look" is not "there is nothing there".
    // Regenerating here would silently invalidate every paired device over a transient stall.
    expect(resolution).toMatchObject({ ok: false, reason: 'unseal_failed' })
    expect(readFileSync(filePath(), 'utf-8')).toBe(onDiskBefore)
    expect(JSON.parse(onDiskBefore).publicKeyB64).toBe(sealed.publicKeyB64)
  })
})

describe('headless keychain context', () => {
  it('mints a plaintext envelope without spawning the helper at all', async () => {
    const minted = await requireKeypair(dir, 'headless')

    // Sealing has a lossless alternative, so a launch with no window to answer a prompt must not
    // spend the helper's timeout budget on one.
    expect(runHelper).not.toHaveBeenCalled()
    expect(readFile().secretKeyFormat).toBe('plaintext')
    expect(minted.secretKey.length).toBe(32)
  })

  it('reads a plaintext envelope without paying the migration seal', async () => {
    const minted = await requireKeypair(dir, 'headless')
    const reloaded = await requireKeypair(dir, 'headless')

    expect(reloaded.publicKeyB64).toBe(minted.publicKeyB64)
    expect(runHelper).not.toHaveBeenCalled()
    expect(readFile().secretKeyFormat).toBe('plaintext')
  })

  it('still unseals an existing sealed envelope, because regenerating is not an option', async () => {
    const sealed = await requireKeypair(dir, 'interactive')
    runHelper.mockClear()

    const reloaded = await requireKeypair(dir, 'headless')

    // D1: a headless serve that skipped this would have to mint, orphaning every paired device.
    expect(reloaded.publicKeyB64).toBe(sealed.publicKeyB64)
    expect(runHelper).toHaveBeenCalledWith(expect.objectContaining({ op: 'unseal' }))
  })

  it('upgrades the headless-minted plaintext secret on the next interactive load', async () => {
    const minted = await requireKeypair(dir, 'headless')
    const upgraded = await requireKeypair(dir, 'interactive')

    expect(upgraded.publicKeyB64).toBe(minted.publicKeyB64)
    expect(readFile().secretKeyFormat).toBe('electron-safe-storage-v1')
  })
})

/**
 * The reviewed exception. Persisting this key in cleartext is permitted because refusing does not
 * cost a re-auth — it mints a different identity next launch and orphans every paired device — but
 * it must be a decision someone can see, switch off, and read in the logs.
 */
describe('cleartext identity fallback policy', () => {
  it('defaults to allowing the fallback and is switched off by the named env flag', () => {
    expect(allowsPlaintextE2EEIdentity({})).toBe(true)
    expect(allowsPlaintextE2EEIdentity({ [REQUIRE_SEALED_E2EE_IDENTITY_ENV]: '1' })).toBe(false)
    // Only an exact '1' opts out; a stray value must not silently disable mobile pairing.
    expect(allowsPlaintextE2EEIdentity({ [REQUIRE_SEALED_E2EE_IDENTITY_ENV]: 'true' })).toBe(true)
  })

  it('warns loudly when a headless mint leaves the private key cleartext at rest', async () => {
    await requireKeypair(dir, 'headless')

    expect(readFile().secretKeyFormat).toBe('plaintext')
    expect(warnedText()).toContain('CLEARTEXT')
    expect(warnedText()).toContain(REQUIRE_SEALED_E2EE_IDENTITY_ENV)
  })

  it('warns again on every load that leaves the key cleartext, because headless never upgrades', async () => {
    await requireKeypair(dir, 'headless')
    warn.mockClear()
    await requireKeypair(dir, 'headless')

    expect(warnedText()).toContain('CLEARTEXT')
  })

  it('refuses the whole identity, writing nothing, when the operator requires a sealed one', async () => {
    process.env[REQUIRE_SEALED_E2EE_IDENTITY_ENV] = '1'
    helperControl.answer = keychainlessHost
    const { resolveE2EEIdentity } = await loadModule()

    const resolution = await resolveE2EEIdentity(dir, { keychainContext: 'headless' })

    // Not "mint it and keep it in memory": that pairs devices the next launch silently orphans.
    expect(resolution).toMatchObject({ ok: false, reason: 'identity_unavailable' })
    expect(existsSync(filePath())).toBe(false)
  })

  it('refuses on an interactive host too when the keychain cannot seal', async () => {
    process.env[REQUIRE_SEALED_E2EE_IDENTITY_ENV] = '1'
    helperControl.answer = keychainlessHost
    const { resolveE2EEIdentity } = await loadModule()

    const resolution = await resolveE2EEIdentity(dir, { keychainContext: 'interactive' })

    expect(resolution).toMatchObject({ ok: false, reason: 'identity_unavailable' })
    expect(existsSync(filePath())).toBe(false)
  })

  it('spends the keychain budget on a headless mint once the fallback is forbidden', async () => {
    process.env[REQUIRE_SEALED_E2EE_IDENTITY_ENV] = '1'

    const minted = await requireKeypair(dir, 'headless')

    // The headless skip exists only because plaintext is a lossless alternative; without it, the
    // bounded helper is the only way the flag can mean "seal" rather than "never pair".
    expect(runHelper).toHaveBeenCalledWith(expect.objectContaining({ op: 'seal' }))
    expect(readFile().secretKeyFormat).toBe('electron-safe-storage-v1')
    expect(minted.secretKey.length).toBe(32)
  })

  it('leaves an already-paired cleartext install working when the flag is turned on later', async () => {
    const paired = await requireKeypair(dir, 'headless')
    const onDiskBefore = readFileSync(filePath(), 'utf-8')

    process.env[REQUIRE_SEALED_E2EE_IDENTITY_ENV] = '1'
    helperControl.answer = keychainlessHost
    const reloaded = await requireKeypair(dir, 'headless')

    // The flag governs new cleartext writes; revoking a key already on disk would strand every
    // paired device for no gain, since the bytes are already there.
    expect(reloaded.publicKeyB64).toBe(paired.publicKeyB64)
    expect(readFileSync(filePath(), 'utf-8')).toBe(onDiskBefore)
    expect(warnedText()).toContain('CLEARTEXT')
  })

  it('upgrades an existing cleartext identity on a headless launch once sealing is required', async () => {
    const paired = await requireKeypair(dir, 'headless')

    process.env[REQUIRE_SEALED_E2EE_IDENTITY_ENV] = '1'
    const reloaded = await requireKeypair(dir, 'headless')

    expect(reloaded.publicKeyB64).toBe(paired.publicKeyB64)
    expect(readFile().secretKeyFormat).toBe('electron-safe-storage-v1')
  })
})
