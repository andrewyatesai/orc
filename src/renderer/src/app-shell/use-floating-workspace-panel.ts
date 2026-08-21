import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction
} from 'react'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  TOGGLE_FLOATING_TERMINAL_EVENT,
  requestFloatingTerminalOpenMaximized
} from '@/lib/floating-terminal'
import { createFloatingWorkspaceTourInteractionSnapshot } from '@/lib/floating-workspace-tour-interaction-snapshot'
import {
  persistFloatingTerminalPanelOpen,
  readPersistedFloatingTerminalPanelViewState
} from '@/components/floating-terminal/floating-terminal-panel-view-state'
import {
  getReusableFloatingWorkspaceTerminal,
  getStartupFloatingWorkspaceDecision
} from '../lib/startup-floating-workspace'
import { useAppStore } from '../store'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type TourInteractionSnapshot = {
  wasPreviouslyInteracted?: boolean
  persisted?: Promise<void>
  recordFeatureInteractionForTour: boolean
} | null

type FloatingWorkspacePanelParams = {
  floatingTerminalEnabled: boolean
  activeView: AppStoreState['activeView']
  activeWorktreeId: string | null
  creationLayoutActive: boolean
  hydrationSucceeded: boolean
  onboardingLoaded: boolean
  onboardingVisible: boolean
  persistedUIReady: boolean
}

type FloatingWorkspacePanel = {
  floatingTerminalOpen: boolean
  setFloatingTerminalOpenWithFocus: (nextOpen: SetStateAction<boolean>) => void
  tourInteractionSnapshotRef: RefObject<TourInteractionSnapshot>
  cancelReturnFocusFrame: () => void
}

export function useFloatingWorkspacePanel({
  floatingTerminalEnabled,
  activeView,
  activeWorktreeId,
  creationLayoutActive,
  hydrationSucceeded,
  onboardingLoaded,
  onboardingVisible,
  persistedUIReady
}: FloatingWorkspacePanelParams): FloatingWorkspacePanel {
  // Why restored: leaving the panel closed forces the user to reopen and re-maximize it,
  // and that size jump reflows a live TUI's buffer (see floating-terminal-panel-view-state).
  const [floatingTerminalOpen, setFloatingTerminalOpen] = useState(
    () => readPersistedFloatingTerminalPanelViewState()?.open === true
  )
  // Why tracked separately: the flag reads false while settings are still loading, and a
  // false read at boot must not be treated as the user disabling the feature. The store
  // initializes `settings` to null (not undefined) - fetchSettings replaces it atomically.
  const floatingTerminalSettingsHydrated = useAppStore((s) => s.settings != null)
  const startupDecisionHandledRef = useRef(false)
  const tourInteractionSnapshotRef = useRef<TourInteractionSnapshot>(null)
  // Why: floating workspace is a transient overlay; hotkey minimize returns focus to the surface the user came from.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const returnFocusFrameRef = useRef<number | null>(null)

  const cancelReturnFocusFrame = useCallback((): void => {
    if (returnFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(returnFocusFrameRef.current)
    returnFocusFrameRef.current = null
  }, [])

  const rememberReturnFocus = useCallback((): void => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) {
      returnFocusRef.current = null
      return
    }
    if (
      active.closest('[data-floating-terminal-panel]') ||
      active.closest('[data-floating-terminal-toggle]')
    ) {
      return
    }
    returnFocusRef.current = active
  }, [])

  const restoreReturnFocus = useCallback((): void => {
    const target = returnFocusRef.current
    returnFocusRef.current = null
    if (!target || !document.contains(target)) {
      return
    }
    cancelReturnFocusFrame()
    returnFocusFrameRef.current = requestAnimationFrame(() => {
      returnFocusFrameRef.current = null
      if (!document.contains(target)) {
        return
      }
      target.focus({ preventScroll: true })
    })
  }, [cancelReturnFocusFrame])

  const setFloatingTerminalOpenWithFocus = useCallback(
    (nextOpen: SetStateAction<boolean>): void => {
      const resolvedOpen =
        typeof nextOpen === 'function' ? nextOpen(floatingTerminalOpen) : nextOpen
      // Why: recordFeatureInteraction updates Zustand subscribers; running it inside the state updater logs a render-phase update warning.
      if (resolvedOpen && !floatingTerminalOpen) {
        tourInteractionSnapshotRef.current = createFloatingWorkspaceTourInteractionSnapshot(
          useAppStore.getState()
        )
        rememberReturnFocus()
      } else if (!resolvedOpen && floatingTerminalOpen) {
        restoreReturnFocus()
      }
      setFloatingTerminalOpen(resolvedOpen)
      // Why gated on the flag: `settings` is null until it hydrates, so the feature-off
      // effect force-closes the panel on every boot. Persisting there would overwrite the
      // user's restored `open` with a value they never chose.
      if (floatingTerminalEnabled) {
        persistFloatingTerminalPanelOpen(resolvedOpen)
      }
    },
    [floatingTerminalEnabled, floatingTerminalOpen, rememberReturnFocus, restoreReturnFocus]
  )

  useEffect(() => {
    const toggleFloatingTerminal = (): void => {
      if (floatingTerminalEnabled) {
        setFloatingTerminalOpenWithFocus((open) => !open)
      }
    }
    window.addEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, toggleFloatingTerminal)
    return () => window.removeEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, toggleFloatingTerminal)
  }, [floatingTerminalEnabled, setFloatingTerminalOpenWithFocus])

  useEffect(() => {
    // Why the hydration gate: this effect fires on every boot while settings are still
    // null, and closing there discards the restored open state before the real flag value
    // arrives. Only a hydrated flag-off is an actual disable.
    if (floatingTerminalSettingsHydrated && !floatingTerminalEnabled) {
      setFloatingTerminalOpenWithFocus(false)
    }
  }, [floatingTerminalSettingsHydrated, floatingTerminalEnabled, setFloatingTerminalOpenWithFocus])

  useEffect(() => {
    const decision = getStartupFloatingWorkspaceDecision({
      activeView,
      activeWorktreeId,
      creationLayoutActive,
      floatingWorkspaceEnabled: floatingTerminalEnabled,
      hydrationSucceeded,
      onboardingLoaded,
      onboardingVisible,
      persistedUIReady,
      startupDecisionHandled: startupDecisionHandledRef.current
    })
    if (decision === 'wait') {
      return
    }

    // Why: startup owns one decision only; later closes or blocker changes must not reopen the panel.
    startupDecisionHandledRef.current = true
    if (decision === 'suppress') {
      return
    }

    const state = useAppStore.getState()
    const reusableTerminal = getReusableFloatingWorkspaceTerminal(
      state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [],
      state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    )
    if (reusableTerminal) {
      state.activateTab(reusableTerminal.unifiedTabId)
      state.setActiveTab(reusableTerminal.terminalTabId)
    } else {
      // Why: the global scratch workspace always executes locally, even when the selected runtime is SSH.
      const terminal = state.createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, {
        activate: false,
        recordInteraction: false
      })
      state.activateTab(terminal.id)
      state.setActiveTab(terminal.id)
    }
    requestFloatingTerminalOpenMaximized()
    setFloatingTerminalOpenWithFocus(true)
  }, [
    activeView,
    activeWorktreeId,
    creationLayoutActive,
    floatingTerminalEnabled,
    hydrationSucceeded,
    onboardingLoaded,
    persistedUIReady,
    setFloatingTerminalOpenWithFocus,
    onboardingVisible
  ])

  return {
    floatingTerminalOpen,
    setFloatingTerminalOpenWithFocus,
    tourInteractionSnapshotRef,
    cancelReturnFocusFrame
  }
}
