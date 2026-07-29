import type { RefObject } from 'react'
import { useShortcutLabel } from '../hooks/useShortcutLabel'
import { OrcaProfileSwitcher } from '../components/orca-profiles/OrcaProfileSwitcher'
import {
  AppRightSidebarToggle,
  AppTitlebarLeftControls,
  AppTitlebarMainStrip
} from './AppTitlebarControls'
import type { AppShellViewModel } from './use-app-shell-view-model'
import type { AppStoreActions } from './use-app-store-actions'

type AppTitlebarSlots = {
  titlebarLeftControls: React.ReactNode
  titlebarMainStrip: React.ReactNode
  rightSidebarToggle: React.ReactNode
  workspaceProfileSwitcher: React.ReactNode
}

export function useAppTitlebarSlots(params: {
  vm: AppShellViewModel
  actions: AppStoreActions
  controlsRef: RefObject<HTMLDivElement | null>
  onToggleExpand: () => void
}): AppTitlebarSlots {
  const { vm, actions, controlsRef, onToggleExpand } = params
  const leftSidebarShortcutLabel = useShortcutLabel('sidebar.left.toggle')
  const rightSidebarShortcutLabel = useShortcutLabel('sidebar.right.toggle')
  const historyBackShortcutLabel = useShortcutLabel('worktree.history.back')
  const historyForwardShortcutLabel = useShortcutLabel('worktree.history.forward')

  const rightSidebarToggle = vm.showRightSidebarControls ? (
    <AppRightSidebarToggle
      shortcutLabel={rightSidebarShortcutLabel}
      onToggle={actions.toggleRightSidebar}
    />
  ) : null

  return {
    rightSidebarToggle,
    titlebarLeftControls: (
      <AppTitlebarLeftControls
        controlsRef={controlsRef}
        isFloating={vm.leftTitlebarChromeLayout.isFloating}
        isFullScreen={vm.isFullScreen}
        showSidebar={vm.showSidebar}
        showTitlebarAppName={vm.settings?.showTitlebarAppName !== false}
        activeView={vm.activeView}
        canGoBackWorktree={vm.canGoBackWorktree}
        canGoForwardWorktree={vm.canGoForwardWorktree}
        leftSidebarShortcutLabel={leftSidebarShortcutLabel}
        historyBackShortcutLabel={historyBackShortcutLabel}
        historyForwardShortcutLabel={historyForwardShortcutLabel}
        onToggleSidebar={actions.toggleSidebar}
        onHideAppName={() => {
          void actions.updateSettings({ showTitlebarAppName: false })
        }}
      />
    ),
    titlebarMainStrip: (
      <AppTitlebarMainStrip
        activeView={vm.activeView}
        creationLayoutActive={vm.creationLayoutActive}
        workspaceChromeActive={vm.workspaceChromeActive}
        showTitlebarExpandButton={vm.showTitlebarExpandButton}
        activeTabCanExpand={vm.activeTabCanExpand}
        showProfileSwitcherInTopRight={vm.showProfileSwitcherInTopRight}
        rightSidebarOpen={vm.rightSidebarOpen}
        rightSidebarToggle={rightSidebarToggle}
        onToggleExpand={onToggleExpand}
      />
    ),
    workspaceProfileSwitcher:
      vm.showProfileSwitcherInTopRight &&
      vm.workspaceChromeActive &&
      vm.leftTitlebarChromeLayout.shouldMount &&
      !vm.stackedSidebarOpen ? (
        <div
          className="absolute top-0 z-10 flex h-[36px] items-center"
          style={
            {
              right: vm.showRightSidebarControls
                ? 'calc(var(--window-controls-width) + 42px)'
                : 'var(--window-controls-width)',
              WebkitAppRegion: 'no-drag'
            } as React.CSSProperties
          }
        >
          <OrcaProfileSwitcher />
        </div>
      ) : null
  }
}
