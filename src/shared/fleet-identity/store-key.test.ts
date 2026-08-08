import { describe, expect, it } from 'vitest'
import {
  createStoreKey,
  formatStoreKey,
  parseStoreKey,
  storeKeysEqual,
  storeKeysOverlap,
  unionStoreKeys,
  type CredentialSurface
} from './store-key'

const configDir: CredentialSurface = { kind: 'config-dir', path: '/home/u/.claude' }
const authFile: CredentialSurface = { kind: 'auth-file', path: '/home/u/.claude/auth.json' }
const scopedKeychain: CredentialSurface = {
  kind: 'keychain-item',
  service: 'Claude Code',
  account: 'acct_1'
}
const legacyKeychain: CredentialSurface = {
  kind: 'keychain-item',
  service: 'Claude Code',
  account: 'legacy'
}

describe('createStoreKey', () => {
  it('is order-independent and deduped, so one store has one key', () => {
    const a = createStoreKey([configDir, authFile, configDir])
    const b = createStoreKey([authFile, configDir])
    expect(formatStoreKey(a)).toBe(formatStoreKey(b))
    expect(a.surfaces).toHaveLength(2)
  })

  it('round-trips through its string form', () => {
    const key = createStoreKey([configDir, authFile, scopedKeychain, legacyKeychain])
    expect(parseStoreKey(formatStoreKey(key))).toEqual(key)
  })

  it('round-trips an empty store', () => {
    expect(parseStoreKey('')).toEqual(createStoreKey([]))
  })

  it('keeps paths with separators unambiguous', () => {
    const key = createStoreKey([{ kind: 'config-dir', path: '/has|pipe:and/colon' }])
    expect(parseStoreKey(formatStoreKey(key))).toEqual(key)
  })

  it.each([
    ['not a string', 7],
    ['unknown kind', 'wallet:/x'],
    ['keychain missing account', 'keychain-item:svc'],
    ['config-dir with extra parts', 'config-dir:a:b']
  ])('returns null for %s', (_label, value) => {
    expect(parseStoreKey(value)).toBeNull()
  })
})

describe('storeKeysOverlap', () => {
  it('treats a PARTIAL overlap as a collision — equality is the wrong test', () => {
    // Two launches with different config dirs that fight over one keychain item.
    const a = createStoreKey([{ kind: 'config-dir', path: '/a' }, scopedKeychain])
    const b = createStoreKey([{ kind: 'config-dir', path: '/b' }, scopedKeychain])
    expect(storeKeysEqual(a, b)).toBe(false)
    expect(storeKeysOverlap(a, b)).toBe(true)
  })

  it('lets genuinely disjoint stores coexist', () => {
    const a = createStoreKey([{ kind: 'config-dir', path: '/a' }, scopedKeychain])
    const b = createStoreKey([{ kind: 'config-dir', path: '/b' }, legacyKeychain])
    expect(storeKeysOverlap(a, b)).toBe(false)
  })

  it('catches the darwin legacy keychain item a config-dir-only key would miss', () => {
    const scopedOnly = createStoreKey([configDir, scopedKeychain])
    const alsoLegacy = createStoreKey([
      { kind: 'config-dir', path: '/other' },
      scopedKeychain,
      legacyKeychain
    ])
    expect(storeKeysOverlap(scopedOnly, alsoLegacy)).toBe(true)
  })

  it('an empty store collides with nothing', () => {
    expect(storeKeysOverlap(createStoreKey([]), createStoreKey([configDir]))).toBe(false)
  })
})

describe('unionStoreKeys', () => {
  it('covers every store a multi-key rotation touches', () => {
    const union = unionStoreKeys([createStoreKey([configDir]), createStoreKey([legacyKeychain])])
    expect(storeKeysOverlap(union, createStoreKey([configDir]))).toBe(true)
    expect(storeKeysOverlap(union, createStoreKey([legacyKeychain]))).toBe(true)
  })
})

describe('path normalization', () => {
  it('treats a trailing separator as the same directory', () => {
    // Same store. Reporting these as disjoint would let a drain proceed while a
    // live CLI still holds the credential.
    const plain = createStoreKey([{ kind: 'config-dir', path: '/home/u/.claude' }])
    const trailing = createStoreKey([{ kind: 'config-dir', path: '/home/u/.claude/' }])
    expect(storeKeysOverlap(plain, trailing)).toBe(true)
    expect(storeKeysEqual(plain, trailing)).toBe(true)
  })

  it('keeps a bare root usable', () => {
    expect(formatStoreKey(createStoreKey([{ kind: 'config-dir', path: '/' }]))).toContain('%2F')
  })

  it('does not fold case — Linux paths are case-sensitive', () => {
    const lower = createStoreKey([{ kind: 'config-dir', path: '/home/u/.claude' }])
    const upper = createStoreKey([{ kind: 'config-dir', path: '/Home/u/.claude' }])
    expect(storeKeysOverlap(lower, upper)).toBe(false)
  })

  it('rejects a malformed percent escape instead of throwing', () => {
    expect(parseStoreKey('config-dir:%')).toBeNull()
  })

  it('does not alias a surface the caller can still mutate', () => {
    const surface = { kind: 'config-dir' as const, path: '/home/u/.claude' }
    const key = createStoreKey([surface])
    surface.path = '/etc/shadow'
    expect(formatStoreKey(key)).toContain('.claude')
  })
})
