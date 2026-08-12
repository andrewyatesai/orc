export const AI_VAULT_SESSION_LIMITS = [250, 500, 1000, 'unlimited'] as const

export type AiVaultSessionLimit = (typeof AI_VAULT_SESSION_LIMITS)[number]

export const DEFAULT_AI_VAULT_SESSION_LIMIT: AiVaultSessionLimit = 250

export function normalizeAiVaultSessionLimit(value: unknown): AiVaultSessionLimit {
  return AI_VAULT_SESSION_LIMITS.includes(value as AiVaultSessionLimit)
    ? (value as AiVaultSessionLimit)
    : DEFAULT_AI_VAULT_SESSION_LIMIT
}

// Translate the user-facing depth choice into the aiVault.listSessions request
// shape: 'unlimited' drops the bound; every numeric choice is a plain limit.
export function aiVaultSessionLimitToListArgs(limit: AiVaultSessionLimit): {
  limit?: number
  unlimited?: boolean
} {
  return limit === 'unlimited' ? { unlimited: true } : { limit }
}
