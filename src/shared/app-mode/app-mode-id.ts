// Frozen: `app.setName`, `appId`, `appUserModelId` and the packaged `productName` may NEVER vary by
// mode. app.setName derives the macOS Keychain item "<appName> Safe Storage" and resolves
// app.getPath('userData') — the directory app-mode.json itself lives in. Varying it would orphan
// every safeStorage secret and split the data directory, so a mode switch would read as a settings wipe.

export const APP_MODE_OPTIONS = [
  { id: 'classic', labelKey: 'appMode.classic' },
  { id: 'alab', labelKey: 'appMode.alab' },
  { id: 'story-world', labelKey: 'appMode.storyWorld' }
] as const

export type AppModeId = (typeof APP_MODE_OPTIONS)[number]['id']

export const DEFAULT_APP_MODE_ID: AppModeId = 'classic'

// hasOwn (not `in`) so a hand-edited "__proto__" cannot pass — mirrors isTopLevelView.
const APP_MODE_LOOKUP: Record<AppModeId, true> = {
  classic: true,
  alab: true,
  'story-world': true
}

/**
 * Rung evaluation. `null` means "this rung has no valid opinion" so the precedence ladder falls
 * through to the next one. Never coerce here: a single coercing function would make an unknown
 * value in a HIGH-precedence rung silently win that rung as `classic`, overriding the user's real
 * lower-precedence choice.
 */
export function parseAppModeId(value: unknown): AppModeId | null {
  return typeof value === 'string' && Object.hasOwn(APP_MODE_LOOKUP, value)
    ? (value as AppModeId)
    : null
}

/** Terminal fallback ONLY. Never use for rung evaluation — use parseAppModeId. */
export function normalizeAppModeId(value: unknown): AppModeId {
  return parseAppModeId(value) ?? DEFAULT_APP_MODE_ID
}
