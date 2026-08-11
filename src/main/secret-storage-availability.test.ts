import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => false),
  getSelectedStorageBackend: vi.fn(() => 'basic_text' as string)
}))

async function loadModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({ safeStorage: safeStorageMock }))
  return import('./secret-storage-availability')
}

beforeEach(() => {
  safeStorageMock.isEncryptionAvailable.mockReset().mockReturnValue(false)
  safeStorageMock.getSelectedStorageBackend.mockReset().mockReturnValue('basic_text')
})

afterEach(() => {
  vi.doUnmock('electron')
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('diagnoseSecretStorage', () => {
  it('reports the Linux backend and the D-Bus session that explain the refusal', async () => {
    const { diagnoseSecretStorage } = await loadModule()
    expect(diagnoseSecretStorage({}, 'linux')).toMatchObject({
      encryptionAvailable: false,
      linuxBackend: 'basic_text',
      hasDbusSession: false,
      passphraseConfigured: false
    })
  })

  it('does not ask for a Linux backend on other platforms', async () => {
    const { diagnoseSecretStorage } = await loadModule()
    expect(diagnoseSecretStorage({}, 'darwin').linuxBackend).toBeNull()
    expect(safeStorageMock.getSelectedStorageBackend).not.toHaveBeenCalled()
  })

  it('survives a backend probe that throws before the app is ready', async () => {
    safeStorageMock.getSelectedStorageBackend.mockImplementation(() => {
      throw new Error('called before ready')
    })
    const { diagnoseSecretStorage } = await loadModule()
    expect(diagnoseSecretStorage({}, 'linux').linuxBackend).toBeNull()
  })

  it('sees a configured operator passphrase', async () => {
    const { diagnoseSecretStorage } = await loadModule()
    const { SECRET_PASSPHRASE_ENV } = await import('./passphrase-sealed-secret')
    expect(
      diagnoseSecretStorage({ [SECRET_PASSPHRASE_ENV]: 'pass' }, 'linux').passphraseConfigured
    ).toBe(true)
  })
})

describe('secretStorageRemedy', () => {
  it('tells a keyring-less host how to get a keyring AND how to use a passphrase', async () => {
    const { diagnoseSecretStorage, secretStorageRemedy } = await loadModule()
    const remedy = secretStorageRemedy(diagnoseSecretStorage({}, 'linux'))
    expect(remedy).toContain('basic_text')
    expect(remedy).toContain('DBUS_SESSION_BUS_ADDRESS is unset')
    expect(remedy).toContain('gnome-keyring')
    expect(remedy).toContain('ORCA_SECRET_PASSPHRASE_FILE')
    expect(remedy).toContain('docs/reference/headless-linux-server.md')
  })

  it('never recommends --password-store=basic, and says why', async () => {
    const { diagnoseSecretStorage, secretStorageRemedy } = await loadModule()
    const remedy = secretStorageRemedy(diagnoseSecretStorage({}, 'linux'))
    expect(remedy).toContain('Do not pass --password-store=basic')
    expect(remedy).toContain('hardcoded constant')
  })

  it('distinguishes a selected-but-unusable keyring from no keyring at all', async () => {
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    const { diagnoseSecretStorage, secretStorageRemedy } = await loadModule()
    const remedy = secretStorageRemedy(
      diagnoseSecretStorage({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus' }, 'linux')
    )
    expect(remedy).toContain('unlock the gnome_libsecret keyring')
    expect(remedy).toContain('DBUS_SESSION_BUS_ADDRESS is set')
    expect(remedy).not.toContain('install gnome-keyring')
  })

  it('reports the passphrase path as the active one once it is configured', async () => {
    const { diagnoseSecretStorage, secretStorageRemedy } = await loadModule()
    const { SECRET_PASSPHRASE_ENV } = await import('./passphrase-sealed-secret')
    const remedy = secretStorageRemedy(
      diagnoseSecretStorage({ [SECRET_PASSPHRASE_ENV]: 'pass' }, 'linux')
    )
    expect(remedy).toContain('sealed with the operator passphrase')
  })
})

describe('warnSecretStorageUnavailableOnce', () => {
  it('logs at most once per process, because every save would otherwise repeat it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { warnSecretStorageUnavailableOnce } = await loadModule()
    warnSecretStorageUnavailableOnce('jira')
    warnSecretStorageUnavailableOnce('linear')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[jira]')
  })
})
