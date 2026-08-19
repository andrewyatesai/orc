import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SYNC_FIT_PANES_EVENT, TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useIpcEvents } from './hooks/useIpcEvents'
import { useAutomationDispatchEvents } from './hooks/useAutomationDispatchEvents'
import RetainedAgentsSyncGate from './components/dashboard/RetainedAgentsSyncGate'
import ClosedEditorTabCleanupGate from './components/editor/ClosedEditorTabCleanupGate'
import { AgentHibernationGate } from './components/AgentHibernationGate'
import { SkillFreshnessNudge } from './components/skills/SkillFreshnessNudge'
import { WorkspacePortScanner } from './components/ports/WorkspacePortScanner'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import { ConfirmationDialogProvider } from './components/confirmation-dialog'
import { LinkRoutingPreferenceDialogProvider } from './components/link-routing-preference-dialog'
import { useGitStatusPolling } from './components/right-sidebar/useGitStatusPolling'
import { useEditorExternalWatch } from './hooks/useEditorExternalWatch'
import { useAutoAckViewedAgent } from './hooks/useAutoAckViewedAgent'
import { useDashboardPopoutBridge } from './components/dashboard/useDashboardPopoutBridge'
import { useUnreadDockBadge } from './hooks/useUnreadDockBadge'
import {
  resolvePrimarySelectionMiddleClickPaste,
  usePrimarySelectionPaste
} from './hooks/usePrimarySelectionPaste'
import { useAppMenuPaste } from './hooks/useAppMenuPaste'
import { useLargeTextControlPaste } from './hooks/useLargeTextControlPaste'
import { useWebSessionTabsSync } from './runtime/web-session-tabs-sync'
import { useRemoteRuntimeRecoveryTriggers } from './runtime/use-remote-runtime-recovery-triggers'
import { useGlobalFileDrop } from './hooks/useGlobalFileDrop'
import { useRadixBodyPointerEventsRecovery } from './hooks/useRadixBodyPointerEventsRecovery'
import type { VirtualizedScrollAnchor } from './hooks/useVirtualizedScrollAnchor'
import { resolveMountedLazyModalIds, type LazyModalId } from './lazy-modal-mount-state'
import PinnedTabCloseDialog from './components/terminal-pane/PinnedTabCloseDialog'
import RunCommandConsentDialog from './components/terminal-pane/RunCommandConsentDialog'
import { useOsc52ClipboardDefaultOnNotice } from './components/terminal-pane/osc52-clipboard-default-on-notice'
import { FloatingTerminalPanel, StatusBar } from './app-shell/app-lazy-surfaces'
import { AppOverlayHost } from './app-shell/AppOverlayHost'
import { AppPageRouter } from './app-shell/AppPageRouter'
import { useAppTitlebarSlots } from './app-shell/use-app-titlebar-slots'
import { AppWorkspaceShell } from './app-shell/AppWorkspaceShell'
import { WindowControls } from './app-shell/WindowControls'
import { runAppStartupHydration } from './app-shell/app-startup-hydration'
import { hasCustomTitleBar } from './app-shell/renderer-window-chrome'
import type { AppShortcutState } from './app-shell/app-shortcut-dispatch'
import { useAppKeyboardShortcuts } from './app-shell/use-app-keyboard-shortcuts'
import { useAppSessionPersistence } from './app-shell/use-app-session-persistence'
import { useAppShellViewModel } from './app-shell/use-app-shell-view-model'
import { useAppStoreActions } from './app-shell/use-app-store-actions'
import { useAppViewPersistence } from './app-shell/use-app-view-persistence'
import { useFloatingWorkspacePanel } from './app-shell/use-floating-workspace-panel'
import { useOnboardingAndFeatureTips } from './app-shell/use-onboarding-and-feature-tips'

function App(): React.JSX.Element {
  const clearUnreadDockBadge = useUnreadDockBadge()
  useRadixBodyPointerEventsRecovery()
  useWebSessionTabsSync()
  // Why: fire pending shared-control reconnect timers and pane recovery
  // backoffs on system resume / browser online (#8255).
  useRemoteRuntimeRecoveryTriggers()

  const actions = useAppStoreActions()
  const vm = useAppShellViewModel()
  const { activeView, activeModal, settings, persistedUIReady, creationLayoutActive } = vm

  // Why: keep virtualized scroll memory above the sidebar's workspace/landing remount so the left list doesn't restart at scrollTop 0.
  const worktreeSidebarScrollOffsetRef = useRef(0)
  const worktreeSidebarScrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  const titlebarLeftControlsRef = useRef<HTMLDivElement | null>(null)
  const [collapsedSidebarHeaderWidth, setCollapsedSidebarHeaderWidth] = useState(0)
  const [mountedLazyModalIds, setMountedLazyModalIds] = useState<Set<LazyModalId>>(() => new Set())
  const [shouldMountAddRepoDialog, setShouldMountAddRepoDialog] = useState(false)
  const unmountAddRepoDialogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useOsc52ClipboardDefaultOnNotice(persistedUIReady)
  usePrimarySelectionPaste(
    resolvePrimarySelectionMiddleClickPaste(settings?.primarySelectionMiddleClickPaste)
  )
  useAppMenuPaste()
  useLargeTextControlPaste()

  const {
    onboarding,
    onboardingLoaded,
    setOnboarding,
    setOnboardingLoaded,
    shouldRenderOnboarding,
    onboardingSettingsDetourActive,
    beginOnboardingSettingsDetour
  } = useOnboardingAndFeatureTips({
    actions,
    activeModal,
    activeView,
    contextualToursAutoEligible: vm.contextualToursAutoEligible,
    featureInteractions: vm.featureInteractions,
    featureTipsSeenIds: vm.featureTipsSeenIds,
    persistedUIReady,
    settings
  })

  const {
    floatingTerminalOpen,
    setFloatingTerminalOpenWithFocus,
    tourInteractionSnapshotRef,
    cancelReturnFocusFrame
  } = useFloatingWorkspacePanel({
    floatingTerminalEnabled: vm.floatingTerminalEnabled,
    activeView,
    activeWorktreeId: vm.activeWorktreeId,
    creationLayoutActive,
    hydrationSucceeded: vm.hydrationSucceeded,
    onboardingLoaded,
    onboardingVisible: shouldRenderOnboarding,
    persistedUIReady
  })
  // Why: once the floating workspace owns tabs, keep it mounted while closed so hidden terminal/browser/editor panes retain local state.
  const shouldMountFloatingTerminalPanel =
    vm.floatingTerminalEnabled && (floatingTerminalOpen || vm.floatingVisibleTabCount > 0)

  const setAppRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: these best-effort App chrome cleanups share the App root lifetime.
      if (!node) {
        cancelReturnFocusFrame()
        clearUnreadDockBadge()
      }
    },
    [cancelReturnFocusFrame, clearUnreadDockBadge]
  )

  useEffect(() => {
    if (activeModal === 'add-repo') {
      if (unmountAddRepoDialogTimerRef.current) {
        clearTimeout(unmountAddRepoDialogTimerRef.current)
        unmountAddRepoDialogTimerRef.current = null
      }
      setShouldMountAddRepoDialog(true)
      return
    }
    if (shouldMountAddRepoDialog && !unmountAddRepoDialogTimerRef.current) {
      // Why: AddRepoDialog's close effect aborts in-flight clone work; keep one closed render before unmounting hidden SSH/remote subscriptions.
      unmountAddRepoDialogTimerRef.current = setTimeout(() => {
        setShouldMountAddRepoDialog(false)
        unmountAddRepoDialogTimerRef.current = null
      }, 0)
    }
    return () => {
      if (unmountAddRepoDialogTimerRef.current) {
        clearTimeout(unmountAddRepoDialogTimerRef.current)
        unmountAddRepoDialogTimerRef.current = null
      }
    }
  }, [activeModal, shouldMountAddRepoDialog])

  // Subscribe to IPC push events
  useIpcEvents()
  useAutomationDispatchEvents()
  // Why: retention runs at App level (in <RetainedAgentsSyncGate />, a null leaf) so "done" agents survive card collapse and its high-churn subscriptions don't re-render App.
  // Why: git polling lives at App level (RightSidebar unmounts when closed, stranding stale Rebasing/Merging badges); gate on workspaceSessionReady so it doesn't compete with first paint.
  useGitStatusPolling({ enabled: vm.workspaceSessionReady })
  // Why: wire file-change watching at App level so the editor keeps hearing FS changes when Explorer unmounts (right-sidebar switches to Source Control/Checks).
  useEditorExternalWatch()
  useGlobalFileDrop()
  useAutoAckViewedAgent()
  useDashboardPopoutBridge(settings?.experimentalAgentDashboardPopout === true)

  // Why: useLayoutEffect fires before paint, so dispatching SYNC_FIT_PANES_EVENT reflows the terminal in the same frame as the width change — no wrongly-sized transient.
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
  }, [vm.sidebarOpen, vm.rightSidebarOpen])

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false
    // Why: declared outside the async block so cleanup can abort it — under StrictMode the first (unmounted) pass would otherwise keep spawning PTYs.
    const abortController = new AbortController()
    void runAppStartupHydration({
      actions,
      abortSignal: abortController.signal,
      isCancelled: () => cancelled,
      onOnboardingLoaded: (state) => {
        setOnboarding(state)
        setOnboardingLoaded(true)
      }
    })
    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [actions, setOnboarding, setOnboardingLoaded])

  useAppSessionPersistence(vm.workspaceSessionReady)
  useAppViewPersistence(vm, actions)

  const handleToggleExpand = useCallback((): void => {
    if (!vm.effectiveActiveTabId) {
      return
    }
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId: vm.effectiveActiveTabId }
      })
    )
  }, [vm.effectiveActiveTabId])

  // Window key listeners are global and long-lived: one registration, but the handler reads current shortcut state each key event.
  const shortcutState: AppShortcutState = {
    activeView,
    activeWorktreeId: vm.activeWorktreeId,
    actions,
    floatingTerminalEnabled: vm.floatingTerminalEnabled,
    floatingTerminalOpen,
    floatingVisibleTabCount: vm.floatingVisibleTabCount,
    keybindings: vm.keybindings,
    terminalShortcutPolicy: settings?.terminalShortcutPolicy,
    setFloatingTerminalOpenWithFocus,
    workspaceChromeActive: vm.workspaceChromeActive,
    creationLayoutActive
  }
  const shortcutStateRef = useRef<AppShortcutState>(shortcutState)
  shortcutStateRef.current = shortcutState
  useAppKeyboardShortcuts(shortcutStateRef)

  useLayoutEffect(() => {
    const controls = titlebarLeftControlsRef.current
    if (!controls) {
      return
    }
    const updateWidth = (): void => {
      setCollapsedSidebarHeaderWidth(controls.getBoundingClientRect().width)
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(controls)
    return () => observer.disconnect()
  }, [
    vm.isFullScreen,
    settings?.showTitlebarAppName,
    vm.showSidebar,
    vm.leftTitlebarChromeLayout.isFloating,
    vm.sidebarOpen
  ])

  const resolvedMountedLazyModalIds = resolveMountedLazyModalIds(activeModal, mountedLazyModalIds)
  if (resolvedMountedLazyModalIds !== mountedLazyModalIds) {
    // Why: lazy-load modals on first use, then keep them mounted so repeat opens preserve state and avoid re-fetch flashes.
    setMountedLazyModalIds(new Set(resolvedMountedLazyModalIds))
  }

  const { titlebarLeftControls, titlebarMainStrip, rightSidebarToggle, workspaceProfileSwitcher } =
    useAppTitlebarSlots({
      vm,
      actions,
      controlsRef: titlebarLeftControlsRef,
      onToggleExpand: handleToggleExpand
    })

  return (
    <div
      ref={setAppRootNode}
      className="flex flex-col h-dvh w-screen overflow-hidden"
      style={
        {
          '--collapsed-sidebar-header-width': `${collapsedSidebarHeaderWidth}px`,
          // Shared so surfaces can avoid the Windows/Linux window-controls overlay without hardcoding 138px everywhere.
          '--window-controls-width': hasCustomTitleBar ? '138px' : '0px',
          // Side-position activity bar uses this to push icons below the Windows/Linux window-controls overlay.
          '--window-controls-height': hasCustomTitleBar ? '36px' : '0px'
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        <ConfirmationDialogProvider>
          <LinkRoutingPreferenceDialogProvider>
            <WorkspacePortScanner enabled={vm.workspaceSessionReady} />
            {/* Why: leaf-mounted retention sync keeps agent-status subscriptions out of the App render tree. */}
            <RetainedAgentsSyncGate />
            {/* Why: EditorPanel unmounts when its last tab closes, so close cleanup must run from an always-mounted host to not leak models. */}
            <ClosedEditorTabCleanupGate />
            <AgentHibernationGate />
            {/* Why: workspace activation is a hot path; activeWorktreeId in reset keys would remount whole surfaces during wake. */}
            <RecoverableRenderErrorBoundary
              boundaryId="app.workspace-shell"
              surface="workspace-shell"
              resetKey={activeView}
              title={translate('auto.App.df1d56bf87', 'The workspace shell hit an error.')}
              description={translate(
                'auto.App.8504ddf267',
                'The app is still running. Retry the shell or use the menu to report the crash details.'
              )}
            >
              <AppWorkspaceShell
                activeView={activeView}
                leftTitlebarChromeLayout={vm.leftTitlebarChromeLayout}
                leftSidebarStyle={vm.leftSidebarStyle}
                showSidebar={vm.showSidebar}
                sidebarOpen={vm.sidebarOpen}
                stackedSidebarOpen={vm.stackedSidebarOpen}
                workspaceChromeActive={vm.workspaceChromeActive}
                showRightSidebarControls={vm.showRightSidebarControls}
                rightSidebarOpen={vm.rightSidebarOpen}
                rightSidebarTab={vm.rightSidebarTab}
                rightSidebarExplorerView={vm.rightSidebarExplorerView}
                shouldMountTerminalWorkbench={vm.shouldMountTerminalWorkbench}
                terminalWorkbenchVisible={vm.workspaceChromeActive}
                showFloatingTerminalButton={vm.showFloatingTerminalButton}
                floatingTerminalOpen={floatingTerminalOpen}
                worktreeScrollOffsetRef={worktreeSidebarScrollOffsetRef}
                worktreeScrollAnchorRef={worktreeSidebarScrollAnchorRef}
                titlebarLeftControls={titlebarLeftControls}
                titlebarMainStrip={titlebarMainStrip}
                rightSidebarToggle={rightSidebarToggle}
                workspaceProfileSwitcher={workspaceProfileSwitcher}
                onToggleFloatingTerminal={() => setFloatingTerminalOpenWithFocus((open) => !open)}
                pageContent={
                  <AppPageRouter
                    activeView={activeView}
                    appMode={vm.appMode}
                    activeWorktreeId={vm.activeWorktreeId}
                    activePendingCreationId={vm.activePendingCreationId}
                    creationLayoutActive={creationLayoutActive}
                    reserveCollapsedSidebarHeaderSpace={vm.leftTitlebarChromeLayout.isFloating}
                  />
                }
              />
            </RecoverableRenderErrorBoundary>
            {shouldMountFloatingTerminalPanel ? (
              <Suspense fallback={null}>
                <RecoverableRenderErrorBoundary
                  boundaryId="overlay.floating-workspace"
                  surface="overlay"
                  resetKey={floatingTerminalOpen}
                  compact
                  title={translate('auto.App.1b3024bcd6', 'The floating workspace hit an error.')}
                  description={translate(
                    'auto.App.7cbfbf622f',
                    'Retry the floating workspace or close and reopen it.'
                  )}
                >
                  <FloatingTerminalPanel
                    open={floatingTerminalOpen}
                    onOpenChange={setFloatingTerminalOpenWithFocus}
                    tourInteractionSnapshot={tourInteractionSnapshotRef.current}
                  />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            {vm.statusBarVisible ? (
              <Suspense
                fallback={
                  <div className="h-6 min-h-[24px] shrink-0 border-t border-border bg-[var(--bg-titlebar,var(--card))]" />
                }
              >
                <RecoverableRenderErrorBoundary
                  boundaryId="overlay.status-bar"
                  surface="overlay"
                  resetKey={activeView}
                  compact
                  title={translate('auto.App.2e8ff36f94', 'The status bar hit an error.')}
                  description={translate(
                    'auto.App.8a023cea1f',
                    'Retry the status bar to remount its controls.'
                  )}
                >
                  <StatusBar floatingTerminalOpen={floatingTerminalOpen} />
                </RecoverableRenderErrorBoundary>
              </Suspense>
            ) : null}
            <AppOverlayHost
              activeModal={activeModal}
              activeView={activeView}
              settings={settings}
              mountedLazyModalIds={resolvedMountedLazyModalIds}
              shouldMountAddRepoDialog={shouldMountAddRepoDialog}
              shouldMountSetupGuideTelemetryObserver={persistedUIReady}
              shouldMountContextualTourOverlay={vm.shouldMountContextualTourOverlay}
              shouldMountUpdateCard={vm.shouldMountUpdateCard}
              shouldMountDictationController={vm.shouldMountDictationController}
              renderPetOverlay={vm.renderPetOverlay}
              petVisible={vm.petVisible}
              hasSshCredentialRequest={vm.hasSshCredentialRequest}
              onboarding={onboarding}
              shouldRenderOnboarding={shouldRenderOnboarding}
              onboardingSettingsDetourActive={onboardingSettingsDetourActive}
              onOnboardingChange={setOnboarding}
              onSettingsDetourStart={beginOnboardingSettingsDetour}
            />
          </LinkRoutingPreferenceDialogProvider>
        </ConfirmationDialogProvider>
      </TooltipProvider>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      <SkillFreshnessNudge />
      <PinnedTabCloseDialog />
      <RunCommandConsentDialog />
      {/* Why: Electron's drag-region hit-test is DOM-order-based (ignores z-index); render last so WindowControls stay clickable. */}
      {hasCustomTitleBar && <WindowControls />}
    </div>
  )
}

export default App
