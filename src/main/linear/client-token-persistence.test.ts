import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PLAINTEXT_OPT_IN_ENV = 'ORCA_ALLOW_PLAINTEXT_PERSISTED_SECRETS'
const PLAINTEXT_PREFIX = 'orca-plaintext-v1:'
const LEGACY_WORKSPACE_ID = 'legacy'

// Why a marked ciphertext instead of an identity mock: the tests have to tell an encrypted blob
// from cleartext on disk, which an identity encryptString cannot express.
const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => {
    const text = value.toString('utf8')
    if (!text.startsWith('enc:')) {
      throw new Error('not ciphertext')
    }
    return text.slice('enc:'.length)
  })
}))

const appMock = vi.hoisted(() => ({ isPackaged: false }))

let tempHome = ''

function legacyEncryptedTokenPath(): string {
  return join(tempHome, '.orca', 'linear-token.enc')
}

function legacyPlaintextTokenPath(): string {
  return join(tempHome, '.orca', 'linear-token.plaintext')
}

function workspaceTokenPath(workspaceId: string): string {
  return join(
    tempHome,
    '.orca',
    'linear-tokens',
    `${Buffer.from(workspaceId).toString('base64url')}.enc`
  )
}

// Every fixture key resolves to the same Linear account, which is what makes the legacy record and
// the workspace record two copies of one credential — the situation the migration has to get right.
function fakeLinearClient(): unknown {
  return class {
    viewer = Promise.resolve({
      displayName: 'Ada',
      email: 'ada@example.com',
      organization: Promise.resolve({ id: 'org-alpha', name: 'Alpha', urlKey: 'alpha' })
    })
  }
}

async function loadClientModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({ app: appMock, safeStorage: safeStorageMock }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  vi.doMock('./linear-sdk', () => ({
    loadLinearSdk: () => ({
      AuthenticationLinearError: class extends Error {},
      LinearClient: fakeLinearClient()
    })
  }))
  return import('./client')
}

function writeLegacyViewer(): void {
  mkdirSync(join(tempHome, '.orca'), { recursive: true })
  writeFileSync(
    join(tempHome, '.orca', 'linear-viewer.json'),
    JSON.stringify({
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationId: 'org-alpha',
      organizationName: 'Alpha'
    })
  )
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-linear-token-persistence-'))
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  safeStorageMock.encryptString.mockImplementation((value: string) =>
    Buffer.from(`enc:${value}`, 'utf8')
  )
  appMock.isPackaged = false
  delete process.env[PLAINTEXT_OPT_IN_ENV]
})

afterEach(() => {
  delete process.env[PLAINTEXT_OPT_IN_ENV]
})

describe('Linear token persistence', () => {
  it('writes safeStorage ciphertext and no plaintext file when encryption is available', async () => {
    const linear = await loadClientModule()

    linear.saveToken('lin_api_alpha')

    expect(readFileSync(legacyEncryptedTokenPath(), 'utf8')).toBe('enc:lin_api_alpha')
    expect(existsSync(legacyPlaintextTokenPath())).toBe(false)
  })

  it('refuses to write the API key when safeStorage is unavailable and the opt-in is unset', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const linear = await loadClientModule()

    linear.saveToken('lin_api_alpha')

    expect(existsSync(legacyEncryptedTokenPath())).toBe(false)
    expect(existsSync(legacyPlaintextTokenPath())).toBe(false)
    // Why: the session must stay usable — the key is held in memory until Orca restarts.
    expect(linear.loadToken({ force: true, workspaceId: LEGACY_WORKSPACE_ID })).toBe(
      'lin_api_alpha'
    )

    // …and the cost the user pays: after a restart nothing is stored, so they reconnect.
    const restarted = await loadClientModule()
    expect(restarted.loadToken({ force: true, workspaceId: LEGACY_WORKSPACE_ID })).toBeNull()
    expect(restarted.hasStoredToken(LEGACY_WORKSPACE_ID)).toBe(false)
  })

  it('does not write cleartext when encryptString throws', async () => {
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error('keychain exploded')
    })
    const linear = await loadClientModule()

    linear.saveToken('lin_api_alpha')

    expect(existsSync(legacyEncryptedTokenPath())).toBe(false)
    expect(existsSync(legacyPlaintextTokenPath())).toBe(false)
  })

  // Why the ciphertext survives a refused save: without safeStorage it cannot be read on this host,
  // so it resurrects nothing here — and deleting it would destroy the user's only copy of a still
  // valid token. testConnection() re-saves the token it just read, so the delete fired on a value
  // that had not changed at all.
  it('keeps an unreadable encrypted token when a save is refused', async () => {
    mkdirSync(join(tempHome, '.orca'), { recursive: true })
    writeFileSync(legacyEncryptedTokenPath(), 'enc:lin_api_rotated_away')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const linear = await loadClientModule()

    linear.saveToken('lin_api_new')

    expect(existsSync(legacyEncryptedTokenPath())).toBe(true)
  })

  it('writes a tagged plaintext file only under the dev opt-in', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    const linear = await loadClientModule()

    linear.saveToken('lin_api_alpha')

    expect(existsSync(legacyEncryptedTokenPath())).toBe(false)
    expect(readFileSync(legacyPlaintextTokenPath(), 'utf8')).toBe(
      `${PLAINTEXT_PREFIX}lin_api_alpha`
    )

    // The tag has to survive a cold read, or the app would send it as part of the key.
    const reloaded = await loadClientModule()
    expect(reloaded.hasStoredToken(LEGACY_WORKSPACE_ID)).toBe(true)
    expect(reloaded.loadToken({ force: true, workspaceId: LEGACY_WORKSPACE_ID })).toBe(
      'lin_api_alpha'
    )
  })

  it('ignores the opt-in in a packaged build', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    appMock.isPackaged = true
    const linear = await loadClientModule()

    linear.saveToken('lin_api_alpha')

    expect(existsSync(legacyPlaintextTokenPath())).toBe(false)
    expect(existsSync(legacyEncryptedTokenPath())).toBe(false)
  })

  it('reads a legacy cleartext token file and re-encrypts it once a keychain exists', async () => {
    writeLegacyViewer()
    writeFileSync(legacyEncryptedTokenPath(), 'lin_api_legacy_cleartext')
    const linear = await loadClientModule()

    expect(linear.loadToken({ force: true, workspaceId: LEGACY_WORKSPACE_ID })).toBe(
      'lin_api_legacy_cleartext'
    )
    // Why this matters: the cleartext an older build left at rest is retired, not just tolerated.
    expect(readFileSync(legacyEncryptedTokenPath(), 'utf8')).toBe('enc:lin_api_legacy_cleartext')
  })

  it('keeps a legacy cleartext token readable when no keychain is available to upgrade it', async () => {
    writeLegacyViewer()
    writeFileSync(legacyEncryptedTokenPath(), 'lin_api_legacy_cleartext')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const linear = await loadClientModule()

    expect(linear.loadToken({ force: true, workspaceId: LEGACY_WORKSPACE_ID })).toBe(
      'lin_api_legacy_cleartext'
    )
    expect(readFileSync(legacyEncryptedTokenPath(), 'utf8')).toBe('lin_api_legacy_cleartext')
  })
})

describe('Linear legacy migration without a keychain', () => {
  beforeEach(() => {
    writeLegacyViewer()
    writeFileSync(legacyEncryptedTokenPath(), 'lin_api_legacy_cleartext')
  })

  // The migration moves ONE token from linear-token.enc to linear-tokens/<id>.enc. When the write is
  // refused there is nothing at the destination, so clearing the source would leave zero copies.
  it('does not delete the legacy token when the migrated copy was not written', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const linear = await loadClientModule()

    await expect(linear.testConnection()).resolves.toMatchObject({ ok: true })

    expect(readFileSync(legacyEncryptedTokenPath(), 'utf8')).toBe('lin_api_legacy_cleartext')
    expect(existsSync(workspaceTokenPath('org-alpha'))).toBe(false)

    // The user's real test: relaunch. They are still connected, not logged out with nothing to restore.
    const restarted = await loadClientModule()
    expect(restarted.hasStoredToken(LEGACY_WORKSPACE_ID)).toBe(true)
    expect(restarted.getStatus().connected).toBe(true)
    expect(restarted.loadToken({ force: true, workspaceId: LEGACY_WORKSPACE_ID })).toBe(
      'lin_api_legacy_cleartext'
    )
  })

  it('completes the migration once the token can be encrypted', async () => {
    const linear = await loadClientModule()

    await expect(linear.testConnection()).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha' }
    })

    expect(readFileSync(workspaceTokenPath('org-alpha'), 'utf8')).toBe(
      'enc:lin_api_legacy_cleartext'
    )
    expect(existsSync(legacyEncryptedTokenPath())).toBe(false)
  })

  it('keeps the previously saved key for the same account when a reconnect cannot be written', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const linear = await loadClientModule()

    await expect(linear.connect('lin_api_rotated')).resolves.toMatchObject({ ok: true })

    // Why the older key survives: nothing was written for the new one, so de-duplicating the legacy
    // record would log the user out at the next launch instead of merely leaving it stale.
    expect(readFileSync(legacyEncryptedTokenPath(), 'utf8')).toBe('lin_api_legacy_cleartext')
    const restarted = await loadClientModule()
    expect(restarted.getStatus().connected).toBe(true)
  })

  it('de-duplicates the legacy record on reconnect once the new key is encrypted on disk', async () => {
    const linear = await loadClientModule()

    await expect(linear.connect('lin_api_rotated')).resolves.toMatchObject({ ok: true })

    expect(readFileSync(workspaceTokenPath('org-alpha'), 'utf8')).toBe('enc:lin_api_rotated')
    expect(existsSync(legacyEncryptedTokenPath())).toBe(false)
  })
})
