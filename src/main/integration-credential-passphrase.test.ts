import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isIntegrationCredentialDecryptionError } from '../shared/integration-credential-errors'

/**
 * The packaged-headless path: safeStorage is unavailable, the dev cleartext opt-in is unreachable,
 * and an operator passphrase is the only thing standing between "token persists" and "re-authenticate
 * on every restart". These tests are written against the shared Jira/Linear writer, which is the seam
 * both stores go through.
 */

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => {
    const text = value.toString('utf8')
    if (!text.startsWith('enc:')) {
      throw new Error('not ciphertext')
    }
    return text.slice('enc:'.length)
  })
}))

const appMock = vi.hoisted(() => ({ isPackaged: true }))

const TOKEN = 'linear_api_key_not_a_real_secret'
const PASSPHRASE = 'operator passphrase for this host'
const PLAINTEXT_OPT_IN_ENV = 'ORCA_ALLOW_PLAINTEXT_PERSISTED_SECRETS'
const PASSPHRASE_ENV = 'ORCA_SECRET_PASSPHRASE'
const PASSPHRASE_FILE_ENV = 'ORCA_SECRET_PASSPHRASE_FILE'

let tempDir = ''
let encryptedPath = ''

async function loadCredentialFile() {
  vi.resetModules()
  vi.doMock('electron', () => ({ app: appMock, safeStorage: safeStorageMock }))
  const module = await import('./integration-credential-file')
  const passphrase = await import('./passphrase-sealed-secret')
  passphrase._resetPassphraseSealStateForTests()
  const availability = await import('./secret-storage-availability')
  availability._resetSecretStorageWarningForTests()
  return module
}

function plaintextPath(): string {
  return encryptedPath.replace(/\.enc$/, '.plaintext')
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
  appMock.isPackaged = true
  tempDir = mkdtempSync(join(tmpdir(), 'orca-credential-passphrase-'))
  mkdirSync(join(tempDir, 'tokens'), { recursive: true })
  encryptedPath = join(tempDir, 'tokens', 'workspace.enc')
  delete process.env[PASSPHRASE_ENV]
  delete process.env[PASSPHRASE_FILE_ENV]
  delete process.env[PLAINTEXT_OPT_IN_ENV]
})

afterEach(() => {
  delete process.env[PASSPHRASE_ENV]
  delete process.env[PASSPHRASE_FILE_ENV]
  delete process.env[PLAINTEXT_OPT_IN_ENV]
  vi.doUnmock('electron')
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('a packaged host with no keychain and an operator passphrase', () => {
  it('persists the token as ciphertext instead of refusing', async () => {
    process.env[PASSPHRASE_ENV] = PASSPHRASE
    const store = await loadCredentialFile()

    expect(store.writeStoredCredentialToken('Linear', encryptedPath, TOKEN)).toBe(
      'passphrase-encrypted'
    )
    const onDisk = readFileSync(encryptedPath, 'utf-8')
    expect(onDisk.startsWith('orca-passphrase-v1:')).toBe(true)
    expect(onDisk).not.toContain(TOKEN)
    expect(existsSync(plaintextPath())).toBe(false)
    expect(store.readStoredCredentialTokenFile('Linear', encryptedPath)).toBe(TOKEN)
  })

  it('accepts the passphrase from a file, which keeps it out of the spawned-terminal environment', async () => {
    const passphraseFile = join(tempDir, 'passphrase')
    writeFileSync(passphraseFile, `${PASSPHRASE}\n`, 'utf-8')
    process.env[PASSPHRASE_FILE_ENV] = passphraseFile
    const store = await loadCredentialFile()

    expect(store.writeStoredCredentialToken('Jira', encryptedPath, TOKEN)).toBe(
      'passphrase-encrypted'
    )
    expect(store.readStoredCredentialTokenFile('Jira', encryptedPath)).toBe(TOKEN)
  })

  it('removes a cleartext sibling an older dev build left behind', async () => {
    writeFileSync(plaintextPath(), `orca-plaintext-v1:${TOKEN}`, 'utf-8')
    process.env[PASSPHRASE_ENV] = PASSPHRASE
    const store = await loadCredentialFile()

    store.writeStoredCredentialToken('Linear', encryptedPath, TOKEN)
    expect(existsSync(plaintextPath())).toBe(false)
  })

  // Retiring cleartext at rest is the whole job of the read-time upgrade, and it used to speak only
  // safeStorage — so on the hosts that need it most a token left in the clear by an older build
  // stayed there forever, even once an operator had configured a passphrase that could seal it.
  it('seals a legacy cleartext token on read when only a passphrase is available', async () => {
    writeFileSync(encryptedPath, TOKEN, 'utf-8')
    process.env[PASSPHRASE_ENV] = PASSPHRASE
    const store = await loadCredentialFile()

    expect(store.readStoredCredentialTokenFile('Jira', encryptedPath)).toBe(TOKEN)

    const atRest = readFileSync(encryptedPath, 'utf-8')
    expect(atRest).not.toBe(TOKEN)
    expect(atRest.startsWith('orca-passphrase-v1:')).toBe(true)
    // And it is still readable afterwards — an upgrade that loses the token is not an upgrade.
    expect(store.readStoredCredentialTokenFile('Jira', encryptedPath)).toBe(TOKEN)
  })

  it('prefers the passphrase over the dev cleartext opt-in even when both are set', async () => {
    appMock.isPackaged = false
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    process.env[PASSPHRASE_ENV] = PASSPHRASE
    const store = await loadCredentialFile()

    expect(store.writeStoredCredentialToken('Linear', encryptedPath, TOKEN)).toBe(
      'passphrase-encrypted'
    )
    expect(existsSync(plaintextPath())).toBe(false)
  })

  it('leaves safeStorage in charge when a keychain does work', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    process.env[PASSPHRASE_ENV] = PASSPHRASE
    const store = await loadCredentialFile()

    expect(store.writeStoredCredentialToken('Linear', encryptedPath, TOKEN)).toBe('encrypted')
    expect(readFileSync(encryptedPath, 'utf-8')).toBe(`enc:${TOKEN}`)
  })

  it('does not rewrite a sealed token when a keychain later appears', async () => {
    process.env[PASSPHRASE_ENV] = PASSPHRASE
    const writer = await loadCredentialFile()
    writer.writeStoredCredentialToken('Linear', encryptedPath, TOKEN)
    const sealed = readFileSync(encryptedPath, 'utf-8')

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    const reader = await loadCredentialFile()
    expect(reader.readStoredCredentialTokenFile('Linear', encryptedPath)).toBe(TOKEN)
    expect(readFileSync(encryptedPath, 'utf-8')).toBe(sealed)
  })
})

describe('a sealed token the host can no longer open', () => {
  async function sealThenReadWith(readEnv: () => void): Promise<unknown> {
    process.env[PASSPHRASE_ENV] = PASSPHRASE
    const writer = await loadCredentialFile()
    writer.writeStoredCredentialToken('Jira', encryptedPath, TOKEN)

    delete process.env[PASSPHRASE_ENV]
    readEnv()
    const reader = await loadCredentialFile()
    try {
      reader.readStoredCredentialTokenFile('Jira', encryptedPath)
      return null
    } catch (error) {
      return error
    }
  }

  it('names the missing passphrase instead of reporting a generic decrypt failure', async () => {
    const error = await sealThenReadWith(() => {})
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('ORCA_SECRET_PASSPHRASE_FILE')
    // Still the canonical message underneath, so IPC-side detection keeps working.
    expect(isIntegrationCredentialDecryptionError(error)).toBe(true)
    expect(message).not.toContain(TOKEN)
  })

  it('names a changed passphrase, and leaves the sealed bytes on disk untouched', async () => {
    const error = await sealThenReadWith(() => {
      process.env[PASSPHRASE_ENV] = 'a different operator passphrase'
    })
    expect((error as Error).message).toContain('different operator passphrase than the one')
    expect((error as Error).message).not.toContain(TOKEN)
    expect(readFileSync(encryptedPath, 'utf-8').startsWith('orca-passphrase-v1:')).toBe(true)
  })
})

describe('a packaged host with neither a keychain nor a passphrase', () => {
  it('still refuses to write, and points at the passphrase as the way out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadCredentialFile()

    expect(store.writeStoredCredentialToken('Linear', encryptedPath, TOKEN)).toBe('memory-only')
    expect(existsSync(encryptedPath)).toBe(false)
    expect(existsSync(plaintextPath())).toBe(false)
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('ORCA_SECRET_PASSPHRASE_FILE')
    expect(logged).not.toContain(TOKEN)
  })
})
