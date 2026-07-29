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

type AppStoreState = ReturnType<typeof useAppStore.getState>

type AppPageRouterProps = {
  activeView: AppStoreState['activeView']
  activeWorktreeId: string | null
  activePendingCreationId: string | null
  creationLayoutActive: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
}

// The full-page surfaces that own the content area. Terminal workbench mounts alongside, not here.
export function AppPageRouter({
  activeView,
  activeWorktreeId,
  activePendingCreationId,
  creationLayoutActive,
  reserveCollapsedSidebarHeaderSpace
}: AppPageRouterProps): React.JSX.Element {
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
