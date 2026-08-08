import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appMock = vi.hoisted(() => ({ isPackaged: false, throwOnAccess: false }))

async function loadPolicyModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    get app() {
      // Why: reproduces `app` being unreadable outside a live main process, which must not crash the predicate.
      if (appMock.throwOnAccess) {
        throw new Error('electron app is not available in this process')
      }
      return appMock
    }
  }))
  return import('./plaintext-secret-policy')
}

beforeEach(() => {
  appMock.isPackaged = false
  appMock.throwOnAccess = false
})

afterEach(() => {
  vi.doUnmock('electron')
  vi.resetModules()
})

describe('allowsPlaintextPersistedSecret', () => {
  it('refuses when the opt-in env var is unset', async () => {
    const { allowsPlaintextPersistedSecret } = await loadPolicyModule()
    expect(allowsPlaintextPersistedSecret({})).toBe(false)
  })

  it('allows only the exact "1" opt-in value', async () => {
    const { allowsPlaintextPersistedSecret, PLAINTEXT_SECRET_OPT_IN_ENV } = await loadPolicyModule()
    expect(allowsPlaintextPersistedSecret({ [PLAINTEXT_SECRET_OPT_IN_ENV]: '1' })).toBe(true)
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      expect(allowsPlaintextPersistedSecret({ [PLAINTEXT_SECRET_OPT_IN_ENV]: value })).toBe(false)
    }
  })

  it('refuses in production even with the opt-in set', async () => {
    const { allowsPlaintextPersistedSecret, PLAINTEXT_SECRET_OPT_IN_ENV } = await loadPolicyModule()
    expect(
      allowsPlaintextPersistedSecret({
        [PLAINTEXT_SECRET_OPT_IN_ENV]: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
    expect(
      allowsPlaintextPersistedSecret({
        [PLAINTEXT_SECRET_OPT_IN_ENV]: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
  })

  it('refuses in a packaged app even with the opt-in set', async () => {
    appMock.isPackaged = true
    const { allowsPlaintextPersistedSecret, PLAINTEXT_SECRET_OPT_IN_ENV } = await loadPolicyModule()
    expect(allowsPlaintextPersistedSecret({ [PLAINTEXT_SECRET_OPT_IN_ENV]: '1' })).toBe(false)
  })

  it('treats an unreadable electron app as unpackaged instead of throwing', async () => {
    // Why isPackaged is true here: it proves the throw is what produced the answer, not the mock's flag.
    appMock.throwOnAccess = true
    appMock.isPackaged = true
    const { allowsPlaintextPersistedSecret, PLAINTEXT_SECRET_OPT_IN_ENV } = await loadPolicyModule()
    expect(() => allowsPlaintextPersistedSecret({})).not.toThrow()
    expect(allowsPlaintextPersistedSecret({})).toBe(false)
    expect(allowsPlaintextPersistedSecret({ [PLAINTEXT_SECRET_OPT_IN_ENV]: '1' })).toBe(true)
  })

  it('reads process.env when no env is passed', async () => {
    const { allowsPlaintextPersistedSecret, PLAINTEXT_SECRET_OPT_IN_ENV } = await loadPolicyModule()
    const previous = process.env[PLAINTEXT_SECRET_OPT_IN_ENV]
    const previousNodeEnv = process.env.NODE_ENV
    try {
      delete process.env[PLAINTEXT_SECRET_OPT_IN_ENV]
      process.env.NODE_ENV = 'test'
      expect(allowsPlaintextPersistedSecret()).toBe(false)
      process.env[PLAINTEXT_SECRET_OPT_IN_ENV] = '1'
      expect(allowsPlaintextPersistedSecret()).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env[PLAINTEXT_SECRET_OPT_IN_ENV]
      } else {
        process.env[PLAINTEXT_SECRET_OPT_IN_ENV] = previous
      }
      process.env.NODE_ENV = previousNodeEnv
    }
  })
})

describe('persisted secret tags', () => {
  it('keeps the on-disk tag vocabulary stable across stores', async () => {
    const { ENCRYPTED_SECRET_PREFIX, PLAINTEXT_SECRET_PREFIX } = await loadPolicyModule()
    // Why: these strings are on disk in existing profiles — changing one silently reclassifies stored secrets.
    expect(ENCRYPTED_SECRET_PREFIX).toBe('orca-safestorage-v1:')
    expect(PLAINTEXT_SECRET_PREFIX).toBe('orca-plaintext-v1:')
  })
})
