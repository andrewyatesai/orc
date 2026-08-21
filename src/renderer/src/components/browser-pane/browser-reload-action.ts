/** Where the reload request came from: the toolbar button, or an explicit menu entry. */
export type BrowserReloadTrigger = 'button' | 'reload' | 'hard-reload'

export type BrowserReloadIntent = 'stop' | 'retry-load' | 'reload' | 'hard-reload'

export type BrowserReloadState = {
  loading: boolean
  loadErrorCode: number | null
}

/**
 * Why: webview.reload() only refreshes a chrome-error:// page, so a failed load has to go through the
 * retry path no matter which entry point asked for it. Only the toolbar button doubles as Stop.
 */
export function resolveBrowserReloadIntent(
  trigger: BrowserReloadTrigger,
  state: BrowserReloadState
): BrowserReloadIntent {
  if (trigger === 'button' && state.loading) {
    return 'stop'
  }
  if (state.loadErrorCode !== null) {
    return 'retry-load'
  }
  return trigger === 'hard-reload' ? 'hard-reload' : 'reload'
}

/** Accessible name for the toolbar button, which is Stop mid-load and Retry after a failure. */
export type BrowserReloadButtonLabelKind = 'stop' | 'retry' | 'reload'

export function resolveBrowserReloadButtonLabelKind(
  state: BrowserReloadState
): BrowserReloadButtonLabelKind {
  if (state.loading) {
    return 'stop'
  }
  return state.loadErrorCode !== null ? 'retry' : 'reload'
}
