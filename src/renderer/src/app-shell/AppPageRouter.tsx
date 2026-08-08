import type { useAppStore } from '../store'
import {
  ActivityPrototypePage,
  AutomationsPage,
  Landing,
  MobilePage,
  Settings,
  SkillsPage,
  TaskPage,
  WorkspaceSpacePage,
  WorktreeCreationPanel
} from './app-lazy-surfaces'

import { ModeCapsuleSlot, modeOwnsWorkspaceBody } from '../app-mode/ModeCapsuleSlot'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type AppPageRouterProps = {
  activeView: AppStoreState['activeView']
  /** Unknown values are normalized to Classic by the capability reader, so this
   *  is deliberately `unknown` rather than AppModeId. */
  appMode: unknown
  activeWorktreeId: string | null
  activePendingCreationId: string | null
  creationLayoutActive: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
}

// The full-page surfaces that own the content area. Terminal workbench mounts alongside, not here.
export function AppPageRouter({
  activeView,
  appMode,
  activeWorktreeId,
  activePendingCreationId,
  creationLayoutActive,
  reserveCollapsedSidebarHeaderSpace
}: AppPageRouterProps): React.JSX.Element {
  // §2.6, structural: Settings is reachable in EVERY mode, so no mode can gate
  // itself out of the mode picker. The mode body replaces the centre region
  // wholesale, and a view a mode does not render simply is not reached — no
  // coercion, no blank pane, and the Classic chain below is untouched.
  if (modeOwnsWorkspaceBody(appMode)) {
    return activeView === 'settings' ? (
      <Settings />
    ) : (
      <ModeCapsuleSlot mode={appMode} slot="workspace-body" />
    )
  }

  return (
    <>
      {activeView === 'settings' ? <Settings /> : null}
      {activeView === 'skills' ? <SkillsPage /> : null}
      {activeView === 'tasks' ? <TaskPage /> : null}
      {activeView === 'automations' ? <AutomationsPage /> : null}
      {activeView === 'activity' ? <ActivityPrototypePage /> : null}
      {activeView === 'space' ? <WorkspaceSpacePage /> : null}
      {activeView === 'mobile' ? <MobilePage /> : null}
      {activeView === 'terminal' && creationLayoutActive && activePendingCreationId ? (
        <WorktreeCreationPanel
          creationId={activePendingCreationId}
          reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
        />
      ) : null}
      {activeView === 'terminal' && !activeWorktreeId && !creationLayoutActive ? <Landing /> : null}
    </>
  )
}
