import { describe, expect, it } from 'vitest'
import {
  aiVaultSessionLimitToListArgs,
  DEFAULT_AI_VAULT_SESSION_LIMIT,
  normalizeAiVaultSessionLimit
} from './ai-vault-session-limit'

describe('ai-vault session limit', () => {
  it('accepts known depths and falls back to the default otherwise', () => {
    expect(normalizeAiVaultSessionLimit(500)).toBe(500)
    expect(normalizeAiVaultSessionLimit('unlimited')).toBe('unlimited')
    expect(normalizeAiVaultSessionLimit(999)).toBe(DEFAULT_AI_VAULT_SESSION_LIMIT)
    expect(normalizeAiVaultSessionLimit(undefined)).toBe(DEFAULT_AI_VAULT_SESSION_LIMIT)
    expect(normalizeAiVaultSessionLimit('all')).toBe(DEFAULT_AI_VAULT_SESSION_LIMIT)
  })

  it('maps the depth choice to list args', () => {
    expect(aiVaultSessionLimitToListArgs(250)).toEqual({ limit: 250 })
    expect(aiVaultSessionLimitToListArgs('unlimited')).toEqual({ unlimited: true })
  })
})
