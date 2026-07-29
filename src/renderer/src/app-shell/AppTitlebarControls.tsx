import type { RefObject } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelRight
} from 'lucide-react'
import logo from '../../../../resources/logo.svg'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { shouldShowWorktreeHistoryControls } from '@/lib/titlebar-worktree-history-controls'
import { translate } from '@/i18n/i18n'
import { ActivityTitlebarControls } from '../components/activity/ActivityTitlebarControls'
import { OrcaProfileSwitcher } from '../components/orca-profiles/OrcaProfileSwitcher'
import { useAppStore } from '../store'
import { hasCustomTitleBar, isMac } from './renderer-window-chrome'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type TitlebarLeftControlsProps = {
  controlsRef: RefObject<HTMLDivElement | null>
  isFloating: boolean
  isFullScreen: boolean
  showSidebar: boolean
  showTitlebarAppName: boolean
  activeView: AppStoreState['activeView']
  canGoBackWorktree: boolean
  canGoForwardWorktree: boolean
  leftSidebarShortcutLabel: string
  historyBackShortcutLabel: string
  historyForwardShortcutLabel: string
  onToggleSidebar: () => void
  onHideAppName: () => void
}

// Why: extracted so the full-width titlebar and the sidebar-width left header share these controls without duplicating the agent badge popover.
export function AppTitlebarLeftControls({
  controlsRef,
  isFloating,
  isFullScreen,
  showSidebar,
  showTitlebarAppName,
  activeView,
  canGoBackWorktree,
  canGoForwardWorktree,
  leftSidebarShortcutLabel,
  historyBackShortcutLabel,
  historyForwardShortcutLabel,
  onToggleSidebar,
  onHideAppName
}: TitlebarLeftControlsProps): React.JSX.Element {
  return (
    // Why: measure the ENTIRE row so TabGroupPanel's collapse spacer reserves enough width; measuring only the inner cluster left back/forward over the first tab.
    // Why: collapsed mode floats in a w-0 wrapper; w-max stops Windows Chromium from shrinking the app name to one glyph.
    <div
      ref={controlsRef}
      className={`flex h-full shrink-0 items-center${isFloating ? ' w-max' : ' w-full'}`}
    >
      <div className="flex h-full items-center">
        {isMac && !isFullScreen ? (
          <div className="titlebar-traffic-light-pad" />
        ) : hasCustomTitleBar ? (
          /* Why: Windows/Linux remove the native title bar, so render the logo plus a ··· button that pops the application menu (as Alt does). */
          <>
            <img src={logo} alt="" aria-hidden className="titlebar-logo" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="titlebar-icon-button"
                  aria-label={translate('auto.App.8b0b8eb54f', 'Application menu')}
                  onClick={() => window.api.ui.popupMenu()}
                >
                  <MoreHorizontal size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.App.8b0b8eb54f', 'Application menu')}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <div className="pl-2" />
        )}
        {showSidebar && !hasCustomTitleBar && showTitlebarAppName && (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="titlebar-app-name"
                aria-label={translate('auto.App.5096cbbc86', 'Orca')}
              >
                <span className="titlebar-app-name-main">
                  {translate('auto.App.5096cbbc86', 'Orca')}
                </span>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={onHideAppName}>
                {translate('auto.App.e81217c1b7', 'Hide App Name')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
        {showSidebar && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle"
                onClick={onToggleSidebar}
                aria-label={translate('auto.App.e4b9e7dff7', 'Toggle sidebar')}
              >
                <PanelLeft size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.App.ce37cf5279', 'Toggle sidebar ({{value0}})', {
                value0: leftSidebarShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {/* Why: Back/Forward span worktree + page history, so show the cluster wherever the shortcut is live (hidden in Settings/non-stack views). */}
      {shouldShowWorktreeHistoryControls(activeView) && (
        // With the sidebar collapsed the header shrink-wraps and ml-auto has no spare width, so keep a fixed gutter before Back.
        <div className="ml-auto mr-3 flex items-center pl-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle sidebar-toggle-compact"
                onClick={() => useAppStore.getState().goBackWorktree()}
                disabled={!canGoBackWorktree}
                aria-label={translate('auto.App.064bd07810', 'Go back')}
              >
                <ArrowLeft size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.App.fe21e8f6f5', 'Go back ({{value0}})', {
                value0: historyBackShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle sidebar-toggle-compact"
                onClick={() => useAppStore.getState().goForwardWorktree()}
                disabled={!canGoForwardWorktree}
                aria-label={translate('auto.App.cf9099fe98', 'Go forward')}
              >
                <ArrowRight size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.App.f7aa73e785', 'Go forward ({{value0}})', {
                value0: historyForwardShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

export function AppRightSidebarToggle({
  shortcutLabel,
  onToggle
}: {
  shortcutLabel: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="sidebar-toggle mr-2"
          onClick={onToggle}
          aria-label={translate('auto.App.9e0b441a91', 'Toggle right sidebar')}
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('auto.App.c184e056de', 'Toggle right sidebar ({{value0}})', {
          value0: shortcutLabel
        })}
      </TooltipContent>
    </Tooltip>
  )
}

type TitlebarMainStripProps = {
  activeView: AppStoreState['activeView']
  creationLayoutActive: boolean
  workspaceChromeActive: boolean
  showTitlebarExpandButton: boolean
  activeTabCanExpand: boolean
  showProfileSwitcherInTopRight: boolean
  rightSidebarOpen: boolean
  rightSidebarToggle: React.ReactNode
  onToggleExpand: () => void
}

export function AppTitlebarMainStrip({
  activeView,
  creationLayoutActive,
  workspaceChromeActive,
  showTitlebarExpandButton,
  activeTabCanExpand,
  showProfileSwitcherInTopRight,
  rightSidebarOpen,
  rightSidebarToggle,
  onToggleExpand
}: TitlebarMainStripProps): React.JSX.Element {
  return (
    <>
      {activeView === 'activity' ? (
        <ActivityTitlebarControls />
      ) : creationLayoutActive ? null : (
        <div
          id="titlebar-tabs"
          className={`flex flex-1 min-w-0 self-stretch${!workspaceChromeActive ? ' invisible pointer-events-none' : ''}`}
        />
      )}
      {showTitlebarExpandButton && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="titlebar-icon-button"
              onClick={onToggleExpand}
              aria-label={translate('auto.App.c1cf0b0e4a', 'Collapse pane')}
              disabled={!activeTabCanExpand}
            >
              <Minimize2 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.App.c1cf0b0e4a', 'Collapse pane')}
          </TooltipContent>
        </Tooltip>
      )}
      {showProfileSwitcherInTopRight ? <OrcaProfileSwitcher /> : null}
      {/* Why: the open right sidebar's header renders its own close button, so hide this duplicate. */}
      {!rightSidebarOpen && rightSidebarToggle}
      {/* Why: reserve space so the Windows/Linux window-controls overlay doesn't obscure content. */}
      {hasCustomTitleBar && <div className="window-controls-titlebar-spacer" />}
    </>
  )
}
