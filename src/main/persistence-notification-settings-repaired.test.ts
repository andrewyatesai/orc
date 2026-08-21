import { describe, expect, it, vi } from 'vitest'

// Why: persistence.ts touches electron at import time; a minimal stub keeps this
// predicate test focused instead of booting the full Store fixture.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-persistence-notification-repaired-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

import { getDefaultNotificationSettings } from '../shared/constants'
import { persistedNotificationSettingsRepaired } from './persistence'

const defaults = getDefaultNotificationSettings()

describe('persistedNotificationSettingsRepaired', () => {
  // The dirty mark exists so a repair reaches disk instead of rerunning every launch — the guard
  // must fire on repairs (so the load is marked dirty) and stay quiet on already-valid input.
  it('reports no repair for a missing block (nothing on disk was overridden)', () => {
    expect(persistedNotificationSettingsRepaired(undefined, defaults)).toBe(false)
  })

  it('reports a repair when the persisted block is not an object', () => {
    expect(persistedNotificationSettingsRepaired(null, defaults)).toBe(true)
    expect(persistedNotificationSettingsRepaired('nope', defaults)).toBe(true)
    expect(persistedNotificationSettingsRepaired([], defaults)).toBe(true)
  })

  it('reports a repair when a field was type-flipped on disk', () => {
    // enabled is a boolean; the string 'false' is coerced back to the default, so a field changed.
    const flipped = { ...defaults, enabled: 'false' as unknown as boolean }
    expect(persistedNotificationSettingsRepaired(flipped, defaults)).toBe(true)
  })

  it('reports no repair when the persisted block already matches the normalized result', () => {
    expect(persistedNotificationSettingsRepaired({ ...defaults }, defaults)).toBe(false)
  })
})
