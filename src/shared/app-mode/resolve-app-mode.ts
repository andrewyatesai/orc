import { DEFAULT_APP_MODE_ID, parseAppModeId, type AppModeId } from './app-mode-id'

export type AppModeSource = 'env' | 'lock' | 'project' | 'default' | 'built-in'

export type AppModeResolution = {
  mode: AppModeId
  source: AppModeSource
}

export type AppModePin = {
  appMode?: unknown
  lock?: unknown
}

export type ResolveAppModeInput = {
  /** ORCA_APP_MODE — session only, never persisted. */
  envMode?: unknown
  /** Parsed app-mode.json sidecar, or null when absent/unreadable. */
  pinned?: AppModePin | null
  /** Repo.appMode — Phase 3. */
  repoOverride?: unknown
  /** Paired web clients always run Classic; they have no menu bar to switch with. */
  isWebClient?: boolean
}

/**
 * The precedence ladder. Evaluated top-down; the first rung parseAppModeId accepts wins.
 *
 * The menu bar, the Settings pane and the settings file are NOT three rungs — they are three
 * writers to the same unlocked-sidecar rung, so last write wins and there is no "which selector
 * wins" question. `lock: true` is the deliberate opt-in exception that hoists the sidecar above
 * the per-project rung and makes both UI selectors read-only.
 */
export function resolveAppMode(input: ResolveAppModeInput): AppModeResolution {
  if (input.isWebClient === true) {
    return { mode: DEFAULT_APP_MODE_ID, source: 'built-in' }
  }
  const env = parseAppModeId(input.envMode)
  if (env) {
    return { mode: env, source: 'env' }
  }
  const pinnedMode = parseAppModeId(input.pinned?.appMode)
  if (pinnedMode && input.pinned?.lock === true) {
    return { mode: pinnedMode, source: 'lock' }
  }
  const repo = parseAppModeId(input.repoOverride)
  if (repo) {
    return { mode: repo, source: 'project' }
  }
  if (pinnedMode) {
    return { mode: pinnedMode, source: 'default' }
  }
  return { mode: DEFAULT_APP_MODE_ID, source: 'built-in' }
}

/** True when the resolved source makes the menu/Settings selectors read-only. */
export function isAppModeSelectionLocked(source: AppModeSource): boolean {
  return source === 'env' || source === 'lock'
}
