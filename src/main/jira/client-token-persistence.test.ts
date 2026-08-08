import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PLAINTEXT_OPT_IN_ENV = 'ORCA_ALLOW_PLAINTEXT_PERSISTED_SECRETS'
const PLAINTEXT_PREFIX = 'orca-plaintext-v1:'
const SITE_URL = 'https://example.atlassian.net'
const EMAIL = 'ada@example.com'

const { netFetchMock, resolveProxyMock, setProxyMock, closeAllConnectionsMock } = vi.hoisted(
  () => ({
    netFetchMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn(),
    closeAllConnectionsMock: vi.fn()
  })
)

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

function siteIdFor(siteUrl: string, email: string): string {
  return createHash('sha256')
    .update(`${siteUrl}\n${email.toLowerCase()}`)
    .digest('base64url')
    .slice(0, 24)
}

function encryptedTokenPath(siteId: string): string {
  return join(tempHome, '.orca', 'jira-tokens', `${Buffer.from(siteId).toString('base64url')}.enc`)
}

function plaintextTokenPath(siteId: string): string {
  return encryptedTokenPath(siteId).replace(/\.enc$/, '.plaintext')
}

async function loadClientModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: appMock,
    net: { fetch: netFetchMock },
    safeStorage: safeStorageMock,
    session: {
      defaultSession: {
        closeAllConnections: closeAllConnectionsMock,
        resolveProxy: resolveProxyMock,
        setProxy: setProxyMock
      }
    }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./client')
}

function mockMyself(): void {
  netFetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        accountId: 'account-alpha',
        displayName: 'Ada',
        emailAddress: EMAIL
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  )
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-jira-token-persistence-'))
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  closeAllConnectionsMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
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

describe('Jira token persistence', () => {
  it('writes safeStorage ciphertext and no plaintext file when encryption is available', async () => {
    const jira = await loadClientModule()
    mockMyself()

    await expect(
      jira.connect({ siteUrl: SITE_URL, email: EMAIL, apiToken: 'pat-alpha' })
    ).resolves.toMatchObject({ ok: true })

    const siteId = siteIdFor(SITE_URL, EMAIL)
    expect(readFileSync(encryptedTokenPath(siteId), 'utf8')).toBe('enc:pat-alpha')
    expect(existsSync(plaintextTokenPath(siteId))).toBe(false)
  })

  it('refuses to write the token when safeStorage is unavailable and the opt-in is unset', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const jira = await loadClientModule()
    mockMyself()

    await expect(
      jira.connect({ siteUrl: SITE_URL, email: EMAIL, apiToken: 'pat-alpha' })
    ).resolves.toMatchObject({ ok: true })

    const siteId = siteIdFor(SITE_URL, EMAIL)
    expect(existsSync(encryptedTokenPath(siteId))).toBe(false)
    expect(existsSync(plaintextTokenPath(siteId))).toBe(false)
    // Why: connect must still succeed — the token lives in memory so this session stays usable.
    expect(jira.getStatus().connected).toBe(true)
    expect(jira.getClients(siteId)[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:pat-alpha`).toString('base64')}`
    )
    // …and the cost the user pays: after a restart the site is gone, not half-connected.
    const restarted = await loadClientModule()
    expect(restarted.getStatus().connected).toBe(false)
  })

  it('does not write cleartext when encryptString throws', async () => {
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error('keychain exploded')
    })
    const jira = await loadClientModule()
    mockMyself()

    await expect(
      jira.connect({ siteUrl: SITE_URL, email: EMAIL, apiToken: 'pat-alpha' })
    ).resolves.toMatchObject({ ok: true })

    const siteId = siteIdFor(SITE_URL, EMAIL)
    expect(existsSync(encryptedTokenPath(siteId))).toBe(false)
    expect(existsSync(plaintextTokenPath(siteId))).toBe(false)
  })

  // Why the ciphertext survives a refused save: without safeStorage it cannot be read on this host,
  // so it resurrects nothing here — and deleting it would destroy the user's only copy of a still
  // valid token every time a keychain-less launch re-saved an unchanged value.
  it('keeps an unreadable encrypted token but removes the readable plaintext sibling', async () => {
    const siteId = siteIdFor(SITE_URL, EMAIL)
    mkdirSync(join(tempHome, '.orca', 'jira-tokens'), { recursive: true })
    writeFileSync(encryptedTokenPath(siteId), 'enc:pat-rotated-away')
    writeFileSync(plaintextTokenPath(siteId), 'orca-plaintext-v1:pat-rotated-away')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const jira = await loadClientModule()
    mockMyself()

    await expect(
      jira.connect({ siteUrl: SITE_URL, email: EMAIL, apiToken: 'pat-new' })
    ).resolves.toMatchObject({ ok: true })

    expect(existsSync(encryptedTokenPath(siteId))).toBe(true)
    expect(existsSync(plaintextTokenPath(siteId))).toBe(false)
  })

  it('writes a tagged plaintext file only under the dev opt-in', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    const jira = await loadClientModule()
    mockMyself()

    await expect(
      jira.connect({ siteUrl: SITE_URL, email: EMAIL, apiToken: 'pat-alpha' })
    ).resolves.toMatchObject({ ok: true })

    const siteId = siteIdFor(SITE_URL, EMAIL)
    expect(existsSync(encryptedTokenPath(siteId))).toBe(false)
    expect(readFileSync(plaintextTokenPath(siteId), 'utf8')).toBe(`${PLAINTEXT_PREFIX}pat-alpha`)

    // The tag has to survive a cold read, or the app would send it as part of the token.
    const reloaded = await loadClientModule()
    expect(reloaded.getClients(siteId)[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:pat-alpha`).toString('base64')}`
    )
  })

  it('ignores the opt-in in a packaged build', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    process.env[PLAINTEXT_OPT_IN_ENV] = '1'
    appMock.isPackaged = true
    const jira = await loadClientModule()
    mockMyself()

    await jira.connect({ siteUrl: SITE_URL, email: EMAIL, apiToken: 'pat-alpha' })

    const siteId = siteIdFor(SITE_URL, EMAIL)
    expect(existsSync(plaintextTokenPath(siteId))).toBe(false)
    expect(existsSync(encryptedTokenPath(siteId))).toBe(false)
  })

  it('reads a legacy cleartext token file and re-encrypts it once a keychain exists', async () => {
    const siteId = 'site-legacy'
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
    writeFileSync(
      join(orcaDir, 'jira-sites.json'),
      JSON.stringify({
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: SITE_URL,
            email: EMAIL,
            displayName: 'Ada',
            accountId: 'account-alpha'
          }
        ]
      })
    )
    writeFileSync(encryptedTokenPath(siteId), 'pat-legacy-cleartext')
    const jira = await loadClientModule()

    expect(jira.getClients(siteId)[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:pat-legacy-cleartext`).toString('base64')}`
    )
    // Why this matters: the cleartext an older build left at rest is retired, not just tolerated.
    expect(readFileSync(encryptedTokenPath(siteId), 'utf8')).toBe('enc:pat-legacy-cleartext')
  })

  it('keeps a legacy cleartext token readable when no keychain is available to upgrade it', async () => {
    const siteId = 'site-legacy'
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(join(orcaDir, 'jira-tokens'), { recursive: true })
    writeFileSync(
      join(orcaDir, 'jira-sites.json'),
      JSON.stringify({
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [
          {
            id: siteId,
            siteUrl: SITE_URL,
            email: EMAIL,
            displayName: 'Ada',
            accountId: 'account-alpha'
          }
        ]
      })
    )
    writeFileSync(encryptedTokenPath(siteId), 'pat-legacy-cleartext')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const jira = await loadClientModule()

    expect(jira.getClients(siteId)[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:pat-legacy-cleartext`).toString('base64')}`
    )
    expect(readFileSync(encryptedTokenPath(siteId), 'utf8')).toBe('pat-legacy-cleartext')
  })
})
