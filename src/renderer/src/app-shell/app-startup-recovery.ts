import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getStartupErrorFallbackUI } from '../lib/startup-ui-hydration'
import { useAppStore } from '../store'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type StartupRecoveryParams = {
  error: unknown
  uiHydrated: boolean
  reconnectStarted: boolean
  abortSignal: AbortSignal
  isCancelled: () => boolean
  hydratePersistedUI: AppStoreState['hydratePersistedUI']
  reconnectPersistedTerminals: AppStoreState['reconnectPersistedTerminals']
}

// Why: force the ready flags and drop pending* maps so the shell still mounts without phantom reconnects on dead PTYs.
function forceShellMountedWithoutPendingReconnects(): void {
  useAppStore.setState({
    workspaceSessionReady: true,
    pendingReconnectWorktreeIds: [],
    pendingReconnectTabByWorktree: {},
    pendingReconnectPtyIdByTabId: {}
  })
}

// Why (issue #1158): leave in-memory state untouched and keep hydrationSucceeded false (default-hydrating here once erased saved tabs); still flip the ready flags so the UI mounts.
export async function recoverFromStartupHydrationFailure({
  error,
  uiHydrated,
  reconnectStarted,
  abortSignal,
  isCancelled,
  hydratePersistedUI,
  reconnectPersistedTerminals
}: StartupRecoveryParams): Promise<void> {
  const stepLabel = error instanceof Error && error.message ? error.message : String(error)
  console.error(
    '[startup] Workspace session hydration failed; leaving disk state untouched:',
    stepLabel,
    error
  )
  if (isCancelled()) {
    return
  }

  // Why: degraded mode stays interactive; later repo/runtime changes must not remain gated forever.
  useAppStore.setState({ startupWorktreeRefreshCompleted: true })
  // Why (issue #1158): only apply default UI if ui.get() never hydrated; otherwise defaults would clobber ui.json via the debounced writer.
  const fallbackUI = getStartupErrorFallbackUI(uiHydrated)
  if (fallbackUI) {
    hydratePersistedUI(fallbackUI, 'startup')
  }
  // Why (issue #1158): sticky toast so the user knows they're in degraded "no-save" mode (hydrationSucceeded stays false); "Restart now" calls app.relaunch to recover.
  toast.error(translate('auto.App.12e77cf12b', 'Session restore failed'), {
    description: translate(
      'auto.App.0a9e810705',
      "Changes won't be saved until restart. Your previous tabs are safe on disk."
    ),
    duration: Infinity,
    dismissible: true,
    action: {
      label: translate('auto.App.caea5b51b9', 'Restart now'),
      onClick: () => {
        void window.api.app.relaunch()
      }
    }
  })

  // Why (issue #1158): reconnect already started; re-running over its partially-mutated state would double-set ptyIds and drain pending* twice.
  if (reconnectStarted) {
    forceShellMountedWithoutPendingReconnects()
    return
  }

  // Why: reconnect flips workspaceSessionReady so the UI mounts, but hydrationSucceeded stays false so the session writer can't overwrite the file we failed to load.
  try {
    await window.api.app.awaitFirstWindowStartupServices()
    await reconnectPersistedTerminals(abortSignal)
  } catch (reconnectErr) {
    console.error('[startup] reconnectPersistedTerminals failed in error path:', reconnectErr)
    // Why (issue #1158): the await may have run during StrictMode teardown; re-check so a cancelled pass 1 doesn't stomp pass 2's hydration.
    if (!isCancelled()) {
      forceShellMountedWithoutPendingReconnects()
    }
  }
}
