import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MiniMaxCookieStore from './minimax-cookie-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

const appMock = vi.hoisted(() => ({ isPackaged: false }))

const electronMock = vi.hoisted(() => ({
  safeStorage: safeStorageMock,
  app: appMock
}))

vi.mock('electron', () => electronMock)

const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const writeSecureFileMock = vi.fn()
const homedirMock = vi.fn(() => '/home/test')

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  writeSecureFile: writeSecureFileMock
}))

const PLAINTEXT_OPT_IN_ENV = 'ORCA_ALLOW_PLAINTEXT_PERSISTED_SECRETS'
const storePath = '/home/test/.orca/minimax-session-cookie.enc'
const envelope = (kind: 'encrypted' | 'plaintext' | 'dev-plaintext', value: string): string =>
  `orca-minimax-cookie:v1:${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof MiniMaxCookieStore> {
  return await import('./minimax-cookie-store')
}

describe('minimax-cookie-store', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
    appMock.isPackaged = false
    delete process.env[PLAINTEXT_OPT_IN_ENV]
  })

  afterEach(() => {
    delete process.env[PLAINTEXT_OPT_IN_ENV]
    vi.resetModules()
  })

  it('returns false when no file exists yet', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.hasMiniMaxSessionCookie()).toBe(false)
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
  })

  it('hardens the cookie file when checking status for an existing cookie', async () => {
    existsSyncMock.mockReturnValue(true)
    const store = await loadStore()
    expect(store.hasMiniMaxSessionCookie()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('still reports an existing cookie when status-path hardening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const store = await loadStore()
    expect(store.hasMiniMaxSessionCookie()).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to harden MiniMax cookie file'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('writes the cookie using safeStorage when encryption is available', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveMiniMaxSessionCookie('_token=abc; minimax_group_id_v2=42')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('_token=abc; minimax_group_id_v2=42')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', '_token=abc; minimax_group_id_v2=42')
    )
  })

  it('refuses to write anything when safeStorage is unavailable and the opt-in is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(() => store.saveMiniMaxSessionCookie('_token=abc')).toThrow(/cannot be stored securely/)
    expect(writeSecureFileMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept in memory only'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PLAINTEXT_OPT_IN_ENV))
    warn.mockRestore()
  })

  it('keeps a refused cookie usable in memory so this session still reports usage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(() => store.saveMiniMaxSessionCookie('_token=abc')).toThrow()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=abc')
    expect(store.hasMiniMaxSessionCookie()).toBe(true)
    warn.mockRestore()
  })

  it('writes a dev-plaintext envelope when safeStorage is unavailable and the opt-in is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveMiniMaxSessionCookie('_token=abc')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('dev-plaintext', '_token=abc')
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PLAINTEXT_OPT_IN_ENV))
    warn.mockRestore()
  })

  it('ignores the opt-in in a packaged build so shipped apps can never persist cleartext', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    appMock.isPackaged = true
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(() => store.saveMiniMaxSessionCookie('_token=abc')).toThrow(/cannot be stored securely/)
    expect(writeSecureFileMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not fall back to cleartext when encryptString throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error('keychain boom')
    })
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(() => store.saveMiniMaxSessionCookie('_token=abc')).toThrow(/cannot be stored securely/)
    expect(writeSecureFileMock).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to encrypt'),
      expect.any(Error)
    )
    warn.mockRestore()
    error.mockRestore()
  })

  it('writes dev-plaintext when encryptString throws and the opt-in is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error('keychain boom')
    })
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveMiniMaxSessionCookie('_token=abc')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('dev-plaintext', '_token=abc')
    )
    warn.mockRestore()
    error.mockRestore()
  })

  it('refuses empty cookies', async () => {
    const store = await loadStore()
    expect(() => store.saveMiniMaxSessionCookie('   ')).toThrow(/required/)
  })

  it('reads decrypted cookie from disk and caches it', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValue('_token=cached; minimax_group_id_v2=9')
    const store = await loadStore()
    const first = store.readMiniMaxSessionCookie()
    const second = store.readMiniMaxSessionCookie()
    expect(first).toBe('_token=cached; minimax_group_id_v2=9')
    expect(second).toBe(first)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledTimes(1)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(Buffer.from('encrypted-payload'))
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('returns null when no file exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBeNull()
  })

  it('returns enveloped plaintext when safeStorage is unavailable and reads succeed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', '_token=plaintext')))
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=plaintext')
    expect(writeSecureFileMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stored in cleartext on disk'))
    warn.mockRestore()
  })

  it('re-encrypts a legacy plaintext envelope once safeStorage is available', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', '_token=legacy-envelope')))
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy-envelope')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', '_token=legacy-envelope')
    )
  })

  it('re-encrypts a dev-plaintext envelope once safeStorage is available', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('dev-plaintext', '_token=dev')))
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=dev')
    expect(writeSecureFileMock).toHaveBeenCalledWith(storePath, envelope('encrypted', '_token=dev'))
  })

  it('still returns the cookie when the re-encrypt upgrade write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', '_token=legacy-envelope')))
    writeSecureFileMock.mockImplementation(() => {
      throw new Error('disk full')
    })
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy-envelope')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to re-encrypt'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('reads legacy plaintext cookies when decrypting is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('_token=legacy'))
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy')
    expect(writeSecureFileMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reads legacy plaintext cookies when decrypting fails and re-encrypts them', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('_token=legacy'))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      envelope('encrypted', '_token=legacy')
    )
  })

  it('does not treat encrypted legacy bytes as plaintext when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('encrypted-payload'))
    const store = await loadStore()
    expect(() => store.readMiniMaxSessionCookie()).toThrow(/could not be decrypted/)
  })

  it('throws for encrypted envelopes when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    const store = await loadStore()
    expect(() => store.readMiniMaxSessionCookie()).toThrow(/could not be decrypted/)
  })

  it('throws when decryption fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(() => store.readMiniMaxSessionCookie()).toThrow(/could not be decrypted/)
  })

  it('clears the cached cookie and removes the file', async () => {
    existsSyncMock.mockReturnValueOnce(true)
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValueOnce('_token=preclear')
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=preclear')
    store.clearMiniMaxSessionCookie()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readMiniMaxSessionCookie()).toBeNull()
  })
})
