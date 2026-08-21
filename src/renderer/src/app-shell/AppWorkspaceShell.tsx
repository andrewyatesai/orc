import { Suspense, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import type { VirtualizedScrollAnchor } from '../hooks/useVirtualizedScrollAnchor'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import { FloatingTerminalToggleButton } from '../components/floating-terminal/FloatingTerminalToggleButton'
import RightSidebar from '../components/right-sidebar'
import Sidebar from '../components/Sidebar'
import { TerminalWorkbenchContainer } from '../components/TerminalWorkbenchContainer'
import type { useAppStore } from '../store'
import { Terminal } from './app-lazy-surfaces'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type LeftTitlebarChromeLayout = {
  shouldMount: boolean
  isFloating: boolean
}

type AppWorkspaceShellProps = {
  activeView: AppStoreState['activeView']
  leftTitlebarChromeLayout: LeftTitlebarChromeLayout
  leftSidebarStyle: React.CSSProperties | undefined
  showSidebar: boolean
  sidebarOpen: boolean
  stackedSidebarOpen: boolean
  workspaceChromeActive: boolean
  showRightSidebarControls: boolean
  rightSidebarOpen: boolean
  rightSidebarTab: AppStoreState['rightSidebarTab']
  rightSidebarExplorerView: AppStoreState['rightSidebarExplorerView']
  shouldMountTerminalWorkbench: boolean
  terminalWorkbenchVisible: boolean
  showFloatingTerminalButton: boolean
  floatingTerminalOpen: boolean
  worktreeScrollOffsetRef: RefObject<number>
  worktreeScrollAnchorRef: RefObject<VirtualizedScrollAnchor | null>
  titlebarLeftControls: React.ReactNode
  titlebarMainStrip: React.ReactNode
  rightSidebarToggle: React.ReactNode
  workspaceProfileSwitcher: React.ReactNode
  pageContent: React.ReactNode
  onToggleFloatingTerminal: () => void
}

function WorktreeSidebar({
  activeView,
  description,
  worktreeScrollOffsetRef,
  worktreeScrollAnchorRef
}: {
  activeView: AppStoreState['activeView']
  /** Pre-translated at the call site so the localization audit sees the literal. */
  description: string
  worktreeScrollOffsetRef: RefObject<number>
  worktreeScrollAnchorRef: RefObject<VirtualizedScrollAnchor | null>
}): React.JSX.Element {
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="sidebar.worktrees"
      surface="sidebar"
      resetKey={activeView}
      title={translate('auto.App.1468601e7b', 'The workspace list hit an error.')}
      description={description}
    >
      <Sidebar
        worktreeScrollOffsetRef={worktreeScrollOffsetRef}
        worktreeScrollAnchorRef={worktreeScrollAnchorRef}
      />
    </RecoverableRenderErrorBoundary>
  )
}

export function AppWorkspaceShell({
  activeView,
  leftTitlebarChromeLayout,
  leftSidebarStyle,
  showSidebar,
  sidebarOpen,
  stackedSidebarOpen,
  workspaceChromeActive,
  showRightSidebarControls,
  rightSidebarOpen,
  rightSidebarTab,
  rightSidebarExplorerView,
  shouldMountTerminalWorkbench,
  terminalWorkbenchVisible,
  showFloatingTerminalButton,
  floatingTerminalOpen,
  worktreeScrollOffsetRef,
  worktreeScrollAnchorRef,
  titlebarLeftControls,
  titlebarMainStrip,
  rightSidebarToggle,
  workspaceProfileSwitcher,
  pageContent,
  onToggleFloatingTerminal
}: AppWorkspaceShellProps): React.JSX.Element {
  return (
    <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
      {/* Why: keep the non-workspace titlebar inside this left+center wrapper so it doesn't span over the right-sidebar column. */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* Why: workspace view drops the full-width titlebar so tab groups extend to the top; settings/landing/tasks keep it. */}
        {!leftTitlebarChromeLayout.shouldMount ? (
          <div className="titlebar">
            <div className="flex items-center shrink-0 mr-2">{titlebarLeftControls}</div>
            {titlebarMainStrip}
          </div>
        ) : null}
        <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
          {showSidebar ? (
            leftTitlebarChromeLayout.shouldMount ? (
              /* Why: when the sidebar is collapsed, take this titlebar-height header out of flex layout so the terminal/editor reclaim the left edge. */
              <div
                className={`flex min-h-0 flex-col shrink-0${sidebarOpen ? '' : ' relative w-0 overflow-visible'}`}
              >
                <div
                  // Why: floating titlebar-left occludes the center column's border-l seam; border-r restores that line, w-max sizes it to its own controls.
                  className={`titlebar-left${
                    leftTitlebarChromeLayout.isFloating
                      ? ' titlebar-left-floating absolute top-0 left-0 z-10 w-max border-r border-border'
                      : ''
                  }`}
                  style={{
                    // Why: custom sidebar appearances are scoped to the sidebar root; mirror those vars onto the header in the same left-column panel.
                    ...(sidebarOpen ? leftSidebarStyle : undefined),
                    // Why: size from the wrapper's live width so the header tracks in-flight drag resizes (persisted to Zustand only on mouseup).
                    width: sidebarOpen ? '100%' : undefined
                  }}
                >
                  {titlebarLeftControls}
                </div>
                <div className="flex min-h-0 flex-1">
                  {/* Why: flex-1/min-h-0 slot needed under the fixed 36px header, else the sidebar collapses to content height and loses its scroll viewport. */}
                  <WorktreeSidebar
                    activeView={activeView}
                    description={translate(
                      'auto.App.bdc71dddc9',
                      'The active workspace remains open. Retry the list or switch views.'
                    )}
                    worktreeScrollOffsetRef={worktreeScrollOffsetRef}
                    worktreeScrollAnchorRef={worktreeScrollAnchorRef}
                  />
                </div>
              </div>
            ) : (
              <WorktreeSidebar
                activeView={activeView}
                description={translate(
                  'auto.App.cba0fafda5',
                  'The active page remains open. Retry the list or switch views.'
                )}
                worktreeScrollOffsetRef={worktreeScrollOffsetRef}
                worktreeScrollAnchorRef={worktreeScrollAnchorRef}
              />
            )
          ) : null}
          <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
            {stackedSidebarOpen ? <div className="titlebar">{titlebarMainStrip}</div> : null}
            <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
              {/* Why: match the RightSidebar header's 36px/top-0 so the toggle's vertical center is identical open vs closed — else the icon jitters. */}
              {workspaceChromeActive && !rightSidebarOpen && (
                <div
                  className="absolute top-0 z-10 flex items-center h-[36px]"
                  style={
                    {
                      // Why: --window-controls-width keeps the toggle clear of the fixed window-controls overlay (138px on custom chrome, 0px otherwise); no internal spacer — one would cover the pane-actions Ellipsis button with an unclickable div.
                      right: 'var(--window-controls-width)',
                      WebkitAppRegion: 'no-drag'
                    } as React.CSSProperties
                  }
                >
                  {rightSidebarToggle}
                </div>
              )}
              {workspaceProfileSwitcher}
              <div className="flex flex-1 min-w-0 min-h-0 flex-col">
                {shouldMountTerminalWorkbench ? (
                  <TerminalWorkbenchContainer isVisible={terminalWorkbenchVisible}>
                    <Suspense fallback={null}>
                      <RecoverableRenderErrorBoundary
                        boundaryId="terminal.workbench"
                        surface="terminal-workbench"
                        resetKey="terminal"
                        title={translate(
                          'auto.App.5a9519aef0',
                          'The workspace workbench hit an error.'
                        )}
                        description={translate(
                          'auto.App.98d4ea2823',
                          'Terminal, browser, or editor rendering failed in this workspace. Retry to remount it.'
                        )}
                      >
                        <Terminal />
                      </RecoverableRenderErrorBoundary>
                    </Suspense>
                  </TerminalWorkbenchContainer>
                ) : null}
                <Suspense fallback={null}>
                  <RecoverableRenderErrorBoundary
                    boundaryId={`page.${activeView}`}
                    surface="page"
                    resetKey={activeView}
                    title={translate('auto.App.b7a714db1e', 'This page hit an error.')}
                    description={translate(
                      'auto.App.03a14f6b5b',
                      'Retry the page or navigate to another Orca surface.'
                    )}
                  >
                    {pageContent}
                  </RecoverableRenderErrorBoundary>
                </Suspense>
              </div>
              {showFloatingTerminalButton ? (
                <FloatingTerminalToggleButton
                  open={floatingTerminalOpen}
                  onToggle={onToggleFloatingTerminal}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {/* Why: keep the shell mounted for layout stability (heavy panels disconnect while closed); unmount on the distraction-free tasks view. */}
      {showRightSidebarControls ? (
        <RecoverableRenderErrorBoundary
          boundaryId="right-sidebar"
          surface="right-sidebar"
          resetKey={
            rightSidebarTab === 'explorer'
              ? `${rightSidebarTab}:${rightSidebarExplorerView}`
              : rightSidebarTab
          }
          title={translate('auto.App.ed6b168d00', 'The right sidebar hit an error.')}
          description={translate(
            'auto.App.8d1e160ed1',
            'Retry the sidebar or switch tabs to reload this surface.'
          )}
        >
          <RightSidebar />
        </RecoverableRenderErrorBoundary>
      ) : null}
    </div>
  )
}
