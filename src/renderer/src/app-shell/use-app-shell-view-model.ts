import { useMemo, useRef, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import { resolveLeftTitlebarChromeLayout } from '@/lib/titlebar-left-chrome'
import { shouldShowWorktreeCreationSurface } from '@/lib/worktree-creation-surface'
import { shouldRenderPetOverlay } from '../components/pet/pet-overlay-visibility'
import { useSystemPrefersDark } from '../components/terminal-pane/use-system-prefers-dark'
import {
  hasRequestedBackgroundTerminalWorktreeMount,
  subscribeBackgroundTerminalWorktreeMountRequests
} from '../components/terminal/background-terminal-worktree-mount'
import {
  canGoBackWorktreeHistory,
  canGoForwardWorktreeHistory
} from '@/store/slices/worktree-nav-history'
import { selectActiveTerminalChromeState } from '../store/active-terminal-chrome-selector'
import { selectFloatingVisibleTabCount } from '../store/selectors'
import { useAppStore } from '../store'
import { shouldMountUpdateCardForStatus } from './remote-workspace-patch-status'

// Every store read and layout derivation the app shell renders from, in one subscription set.
export function useAppShellViewModel() {
  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
  const featureTipsSeenIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const terminalChrome = useAppStore(useShallow(selectActiveTerminalChromeState))
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  // Why: the creation surface owns the tab strip from the first pending frame; gating on the delayed loader flag swapped the tab bar mid-create.
  const activePendingCreationExists = useAppStore(
    (s) =>
      s.activePendingCreationId !== null &&
      s.pendingWorktreeCreations[s.activePendingCreationId] !== undefined
  )
  const floatingVisibleTabCount = useAppStore(selectFloatingVisibleTabCount)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const hydrationSucceeded = useAppStore((s) => s.hydrationSucceeded)
  const backgroundTerminalMountRequested = useSyncExternalStore(
    subscribeBackgroundTerminalWorktreeMountRequests,
    hasRequestedBackgroundTerminalWorktreeMount,
    hasRequestedBackgroundTerminalWorktreeMount
  )
  const keybindings = useAppStore((s) => s.keybindings)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const floatingTerminalEnabled = useAppStore((s) => s.settings?.floatingTerminalEnabled === true)
  const floatingTerminalTriggerLocation = useAppStore(
    (s) => s.settings?.floatingTerminalTriggerLocation ?? 'floating-button'
  )
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const showDotfilesByWorktree = useAppStore((s) => s.showDotfilesByWorktree)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const markdownTocPanelWidth = useAppStore((s) => s.markdownTocPanelWidth)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarExplorerView = useAppStore((s) => s.rightSidebarExplorerView)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const settings = useAppStore((s) => s.settings)
  const dictationState = useAppStore((s) => s.dictationState)
  const hasSshCredentialRequest = useAppStore((s) => s.sshCredentialQueue.length > 0)
  const petEnabled = useAppStore((s) => s.settings?.experimentalPet === true)
  const petVisible = useAppStore((s) => s.petVisible)
  const canGoBackWorktree = useAppStore(canGoBackWorktreeHistory)
  const canGoForwardWorktree = useAppStore(canGoForwardWorktreeHistory)

  const systemPrefersDark = useSystemPrefersDark()
  const leftSidebarStyle = useMemo(
    () => resolveLeftSidebarStyleVariables(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  ) as React.CSSProperties | undefined

  const { activeWorktreeId, tabCount, activeTabCanExpand, effectiveActiveTabExpanded } =
    terminalChrome
  const hasMountedTerminalWorkbenchRef = useRef(false)
  if (activeWorktreeId !== null || backgroundTerminalMountRequested) {
    hasMountedTerminalWorkbenchRef.current = true
  }
  // Why: visible worktree creation owns its faux tab strip start to finish; keep the previous workspace mounted for retention without real chrome.
  const creationLayoutActive = shouldShowWorktreeCreationSurface({
    activeView,
    activePendingCreationId,
    hasActivePendingCreation: activePendingCreationExists
  })
  const workspaceChromeActive =
    activeView === 'terminal' && activeWorktreeId !== null && !creationLayoutActive
  // Activity/Space are full-page navigation surfaces (like Settings), so the worktree sidebar is hidden there.
  const showSidebar =
    activeView !== 'settings' &&
    activeView !== 'activity' &&
    activeView !== 'space' &&
    activeView !== 'skills'
  // Tasks/Landing show the full titlebar only when the sidebar is collapsed; open, they mirror workspace view (creation suppresses it).
  const stackedSidebarOpen =
    !workspaceChromeActive && !creationLayoutActive && showSidebar && sidebarOpen

  return {
    ...terminalChrome,
    activeView,
    activeModal,
    activeContextualTourId,
    activePendingCreationId,
    featureTipsSeenIds,
    featureInteractions,
    contextualToursAutoEligible,
    floatingVisibleTabCount,
    workspaceSessionReady,
    hydrationSucceeded,
    keybindings,
    settings,
    statusBarVisible,
    sidebarWidth,
    sidebarOpen,
    groupBy,
    sortBy,
    projectOrderBy,
    showSleepingWorkspaces,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    showDotfilesByWorktree,
    filterRepoIds,
    acknowledgedAgentsByPaneKey,
    persistedUIReady,
    rightSidebarWidth,
    markdownTocPanelWidth,
    rightSidebarOpen,
    rightSidebarTab,
    rightSidebarExplorerView,
    isFullScreen,
    hasSshCredentialRequest,
    petVisible,
    canGoBackWorktree,
    canGoForwardWorktree,
    leftSidebarStyle,
    floatingTerminalEnabled,
    creationLayoutActive,
    workspaceChromeActive,
    showSidebar,
    stackedSidebarOpen,
    // Why: skip the terminal bundle on the landing path, but once mounted keep hidden panes alive through sleep/shutdown when activeWorktreeId briefly goes null.
    shouldMountTerminalWorkbench:
      activeWorktreeId !== null ||
      backgroundTerminalMountRequested ||
      hasMountedTerminalWorkbenchRef.current,
    showFloatingTerminalButton:
      floatingTerminalEnabled &&
      (floatingTerminalTriggerLocation === 'floating-button' || !statusBarVisible),
    showTitlebarExpandButton: workspaceChromeActive && tabCount < 2 && effectiveActiveTabExpanded,
    activeTabCanExpand,
    // Visible creation keeps only the top-left window chrome; tabs and right-sidebar chrome stay gated by workspaceChromeActive.
    leftTitlebarChromeLayout: resolveLeftTitlebarChromeLayout({
      workspaceChromeActive,
      stackedSidebarOpen,
      creationLayoutActive,
      sidebarOpen
    }),
    // Full-page navigation surfaces own the whole content area, so suppress right-sidebar controls.
    showRightSidebarControls: !creationLayoutActive && canShowRightSidebarForView(activeView),
    showProfileSwitcherInTopRight: !(showSidebar && sidebarOpen),
    shouldMountContextualTourOverlay: activeContextualTourId !== null,
    shouldMountUpdateCard: shouldMountUpdateCardForStatus(updateStatus),
    shouldMountDictationController: settings?.voice?.enabled === true || dictationState !== 'idle',
    renderPetOverlay: shouldRenderPetOverlay({ persistedUIReady, petEnabled, petVisible })
  }
}

export type AppShellViewModel = ReturnType<typeof useAppShellViewModel>
