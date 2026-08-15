import { useEffect, useMemo } from 'react'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme } from '../lib/document-theme'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import type { useAppStore } from '../store'
import { isMac } from './renderer-window-chrome'
import type { AppShellViewModel } from './use-app-shell-view-model'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type ViewPersistenceActions = Pick<
  AppStoreState,
  | 'refreshAllGitHub'
  | 'bumpGitHubPRVisibleRefreshGeneration'
  | 'reportVisibleGitHubPRRefreshCandidates'
>

export function useAppViewPersistence(
  viewModel: AppShellViewModel,
  actions: ViewPersistenceActions
): void {
  const {
    persistedUIReady,
    activeView,
    settings,
    sidebarWidth,
    rightSidebarOpen,
    rightSidebarTab,
    rightSidebarExplorerView,
    rightSidebarWidth,
    markdownTocPanelWidth,
    combinedDiffFileTreeWidth,
    groupBy,
    sortBy,
    projectOrderBy,
    showSleepingWorkspaces,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    showDotfilesByWorktree,
    filterRepoIds,
    acknowledgedAgentsByPaneKey
  } = viewModel

  const durableUI = useMemo(
    () => ({
      sidebarWidth,
      rightSidebarOpen,
      rightSidebarTab,
      rightSidebarExplorerView,
      rightSidebarWidth,
      markdownTocPanelWidth,
      combinedDiffFileTreeWidth,
      groupBy,
      sortBy,
      projectOrderBy,
      showActiveOnly: false,
      hideSleepingWorkspaces: !showSleepingWorkspaces,
      showSleepingWorkspaces,
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      showDotfilesByWorktree,
      filterRepoIds,
      // Why: acknowledgedAgentsByPaneKey rides this debounced save so dashboard auto-acks (which fire
      // on focus/visibility) and the in-memory ack cleanup paths in agent-status.ts both reach disk
      // through map identity changes. Without persisting, acked agent rows come back bold after restart.
      acknowledgedAgentsByPaneKey
    }),
    [
      sidebarWidth,
      rightSidebarOpen,
      rightSidebarTab,
      rightSidebarExplorerView,
      rightSidebarWidth,
      markdownTocPanelWidth,
      combinedDiffFileTreeWidth,
      groupBy,
      sortBy,
      projectOrderBy,
      showSleepingWorkspaces,
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      showDotfilesByWorktree,
      filterRepoIds,
      acknowledgedAgentsByPaneKey
    ]
  )

  // Why (#9002): activeView is deliberately NOT in the durable payload. It used to ride this same
  // 150ms writer (#8265), so every top-level view switch scheduled a full durable-state save.
  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    const timer = window.setTimeout(() => {
      void window.api.ui.set(durableUI)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [persistedUIReady, durableUI])

  // Why (#9002): activeView has its own tiny profile preference, so it can track every switch without scheduling the multi-MB durable-state writer.
  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    void window.api.ui.set({ activeView })
  }, [activeView, persistedUIReady])

  // Apply theme to document
  useEffect(() => {
    if (!settings) {
      return
    }
    if (settings.theme === 'dark') {
      applyDocumentTheme('dark')
      return undefined
    } else if (settings.theme === 'light') {
      applyDocumentTheme('light')
      return undefined
    }
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyDocumentTheme('system')
      const handler = (): void => {
        applyDocumentTheme('system')
        // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
        scheduleRuntimeGraphSync()
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    
  }, [settings])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(settings?.appFontFamily)
    )
  }, [settings?.appFontFamily])

  // Refresh GitHub data (PR/issue status) when window regains focus
  useEffect(() => {
    const handler = (): void => {
      if (document.visibilityState === 'visible') {
        actions.refreshAllGitHub()
        actions.bumpGitHubPRVisibleRefreshGeneration()
      } else {
        actions.reportVisibleGitHubPRRefreshCandidates([], Date.now())
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [actions])

  // Why (STA-2383): macOS throttles the backgrounded window; on occlusion-uncover only `focus`
  // fires (invalidate-only), so the app-shell's dvh height stays stale and the bottom status bar
  // is clipped off-screen until a manual resize. Relay the genuine hidden→visible reveal so main
  // runs the same full repaint (size jiggle) that show/restore/resume get, recomputing the layout.
  useEffect(() => {
    if (!isMac || isPairedWebClientWindow()) {
      return
    }
    const handler = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }
      window.api?.ui?.notifyWindowRevealed?.()
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])
}
