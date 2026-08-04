import { useEffect } from 'react'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
} from '../../../shared/updater-renderer-events'
import { isRemoteWorkspaceSnapshotApplyInProgress } from '../hooks/useIpcEvents'
import { attachAppAutoCloseAfterMergeController } from '../components/sidebar/auto-close-after-merge-controller'
import { shutdownBufferCaptures } from '../components/terminal-pane/shutdown-buffer-captures'
import { getSystemPrefersDarkSnapshot } from '../components/terminal-pane/use-system-prefers-dark'
import { dispatchWindowCloseRequest } from '../components/window-close-request-coordinator'
import { buildActiveViewUnloadPatch } from '../lib/active-view-persist'
import { createSessionWriteSubscriber } from '../lib/session-write-subscriber'
import {
  createShutdownCheckpointBeforeUnloadHandler,
  createShutdownCheckpointGuard
} from '../lib/shutdown-checkpoint-guard'
import { registerUpdaterBeforeUnloadBypass } from '../lib/updater-beforeunload'
import {
  buildWorkspaceSessionPayload,
  shouldPersistWorkspaceSession
} from '../lib/workspace-session'
import {
  buildWorkspaceSessionHostSnapshots,
  patchWorkspaceSessionByHost
} from '../lib/workspace-session-host-persistence'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual,
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'
import { applyRemoteWorkspacePatchStatus } from './remote-workspace-patch-status'

// Why: bound the resume-record loss window on a hard kill to ~1 min; capture skips unchanged records so per-tick cost is negligible.
const SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS = 60_000

function captureShutdownCheckpoint(): void {
  const shouldCaptureSession = shouldPersistWorkspaceSession(useAppStore.getState())
  if (shouldCaptureSession) {
    for (const capture of shutdownBufferCaptures.values()) {
      try {
        // Why the store-limit cap here only: quit-time buffers migrate straight to disk
        // snapshot files (P5 deep restore replays them next launch); sleep-time captures
        // keep the small default because they stay resident in Zustand/session sync.
        capture({
          includeLocalBuffers: false,
          bufferByteLimit: TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
        })
      } catch {
        // Don't let one pane's failure block the rest.
      }
    }
    // Why: agent provider session ids live only in agentStatusByPaneKey, which is in-memory.
    // Capture them into the persisted sleeping-session map so a daemon/session death while the
    // app is closed can still cold-restore via the agent's resume command (#5232).
    useAppStore.getState().captureAllSleepingAgentSessions('quit')
  }
  // Why: re-read state after capture() populated scrollback buffers into the store via Zustand
  // setters. The earlier read is only for the gating flags and would miss those updates.
  const freshState = useAppStore.getState()
  const sessionSnapshots = shouldCaptureSession
    ? buildWorkspaceSessionHostSnapshots(buildWorkspaceSessionPayload(freshState), freshState)
    : []
  // Why: one blocking checkpoint closes the immediate-quit race for both the narrow view
  // preference and the larger session recovery snapshots.
  window.api.app.stageBeforeUnloadSync({
    sessions: sessionSnapshots,
    ui: buildActiveViewUnloadPatch(freshState)
  })
}

function persistSessionPatchToHostsAndRemotes(
  patch: Parameters<typeof patchWorkspaceSessionByHost>[1]
): void {
  const state = useAppStore.getState()
  // Why: route each host's worktree-scoped slice to its own partition; keep the local write so the remote upload chain below preserves ordering.
  const localWrite = patchWorkspaceSessionByHost(window.api.session, patch, state)
  void localWrite
  const hydratedTargetIds = Array.from(state.remoteWorkspaceHydratedTargetIds).filter(
    (targetId) => state.remoteWorkspaceSyncStatusByTargetId[targetId]?.phase !== 'conflict'
  )
  if (hydratedTargetIds.length === 0) {
    return
  }
  void localWrite
    .then(() => window.api.remoteWorkspace?.setForConnectedTargets({ hydratedTargetIds }))
    .then((results) => {
      for (const { targetId, result } of results ?? []) {
        applyRemoteWorkspacePatchStatus(targetId, result)
      }
    })
    .catch((err) => {
      for (const targetId of hydratedTargetIds) {
        useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
          phase: 'error',
          direction: 'push',
          message: err instanceof Error ? err.message : 'Workspace upload failed'
        })
      }
    })
}

export function useAppSessionPersistence(workspaceSessionReady: boolean): void {
  useEffect(() => {
    setRuntimeGraphStoreStateGetter(useAppStore.getState)
    return () => {
      setRuntimeGraphStoreStateGetter(null)
    }
  }, [])

  useEffect(() => {
    let previousKey = getRuntimeMobileSessionSyncKey(useAppStore.getState())
    return useAppStore.subscribe((state, previousState) => {
      // Why: this fires on every store mutation; read the cached prefers-dark snapshot instead of allocating a throwaway MediaQueryList via matchMedia each tick.
      const systemPrefersDark = getSystemPrefersDarkSnapshot()
      // Why: skip the key build when every input is reference-unchanged; the gate mirrors every field getRuntimeMobileSessionSyncKey uses.
      if (
        canSkipRuntimeMobileSessionSyncKeyBuild(
          state,
          previousState,
          systemPrefersDark,
          previousKey.systemPrefersDark
        )
      ) {
        return
      }
      const nextKey = getRuntimeMobileSessionSyncKey(
        state,
        previousState,
        previousKey,
        systemPrefersDark
      )
      if (runtimeMobileSessionSyncKeysEqual(nextKey, previousKey)) {
        return
      }
      previousKey = nextKey
      scheduleRuntimeGraphSync()
    })
  }, [])

  useEffect(() => registerUpdaterBeforeUnloadBypass(), [])

  // Why: attach at App level (not inside RightSidebar) so merge-driven auto-close still fires when
  // the sidebar is closed. The controller is a no-op whenever `settings.autoCloseAfterMerge` is false.
  useEffect(() => attachAppAutoCloseAfterMergeController(), [])

  useEffect(() => {
    setRuntimeGraphSyncEnabled(workspaceSessionReady)
    return () => {
      setRuntimeGraphSyncEnabled(false)
    }
  }, [workspaceSessionReady])

  // Why: session persistence only writes to disk; a Zustand subscribe() outside React drops ~15 render-cycle subscriptions and their re-renders on every tab/file/browser change.
  useEffect(() => {
    return createSessionWriteSubscriber({
      store: useAppStore,
      shouldSchedulePersist: () => !isRemoteWorkspaceSnapshotApplyInProgress(),
      persist: ({ patch }) => persistSessionPatchToHostsAndRemotes(patch)
    })
  }, [])

  // On shutdown, capture terminal scrollback buffers and flush all durable renderer state through
  // one synchronous main-process checkpoint.
  useEffect(() => {
    // Why: beforeunload fires twice during a manual quit — once from the synthetic dispatch in the
    // onWindowCloseRequested handler (captures good data while TerminalPanes are still mounted), and
    // again from the native window close triggered by confirmWindowClose(). Between these two
    // firings, PTY exit events can arrive and unmount TerminalPanes, emptying shutdownBufferCaptures.
    // The guard prevents the second call from overwriting good session data with an empty snapshot.
    const shutdownCheckpoint = createShutdownCheckpointGuard(captureShutdownCheckpoint)
    const persistBeforeUnload = createShutdownCheckpointBeforeUnloadHandler(shutdownCheckpoint)
    window.addEventListener('beforeunload', persistBeforeUnload)
    window.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.reset)
    window.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, shutdownCheckpoint.reset)
    window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.reset)
    return () => {
      window.removeEventListener('beforeunload', persistBeforeUnload)
      window.removeEventListener(ORCA_APP_RESTART_ABORTED_EVENT, shutdownCheckpoint.reset)
      window.removeEventListener(
        ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
        shutdownCheckpoint.reset
      )
      window.removeEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, shutdownCheckpoint.reset)
    }
  }, [])

  // Why: beforeunload never fires on a hard kill (crash, forced update, TerminateProcess), so periodically capture agent session ids (not scrollback) so live agents keep a resume record.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!shouldPersistWorkspaceSession(useAppStore.getState())) {
        return
      }
      useAppStore.getState().captureAllSleepingAgentSessions('periodic')
    }, SLEEPING_AGENT_RESUME_CAPTURE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  // Why: subscribe at the always-mounted App root — Terminal owns the confirm flow but isn't mounted on the landing page, so subscribing there left File→Exit / Ctrl+Q with no listener (#5144).
  useEffect(() => {
    return window.api.ui.onWindowCloseRequested(dispatchWindowCloseRequest)
  }, [])

  // Why no periodic scrollback save: the old 3-min re-serialize (#461) stalled the main thread for seconds; the out-of-process daemon (#729) is the durable replacement, non-daemon users lose in-session scrollback on unexpected exit.
}
