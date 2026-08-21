import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'

// Route-level and overlay surfaces, kept out of the entry bundle. App mounts these behind <Suspense>.
export const Landing = lazy(() => import('../components/Landing'))
export const WorktreeCreationPanel = lazy(
  () => import('../components/worktree-creation/WorktreeCreationPanel')
)
export const TaskPage = lazy(() => import('../components/TaskPage'))
export const AutomationsPage = lazy(() => import('../components/automations/AutomationsPage'))
export const ActivityPrototypePage = lazy(
  () => import('../components/activity/ActivityPrototypePage')
)
export const Settings = lazy(() => import('../components/settings/Settings'))
export const SkillsPage = lazy(() => import('../components/skills/SkillsPage'))
export const WorkspaceSpacePage = lazy(
  () => import('../components/workspace-space/WorkspaceSpacePage')
)
export const MobilePage = lazy(() => import('../components/mobile/MobilePage'))
export const QuickOpen = lazy(() => import('../components/QuickOpen'))
export const FederatedSearchPalette = lazy(() => import('../components/FederatedSearchPalette'))
export const WorktreeJumpPalette = lazy(() => import('../components/WorktreeJumpPalette'))
export const WorkspaceCleanupDialog = lazy(
  () => import('../components/workspace-cleanup/WorkspaceCleanupDialog')
)
export const Terminal = lazy(() => import('../components/Terminal'))
export const StatusBar = lazy(() =>
  import('../components/status-bar/StatusBar').then((module) => ({ default: module.StatusBar }))
)
export const SetupGuideModal = lazy(() => import('../components/setup-guide/SetupGuideModal'))
export const FeatureWallModal = lazy(() => import('../components/feature-wall/FeatureWallModal'))
export const FeatureTipsModal = lazy(() => import('../components/feature-tips/FeatureTipsModal'))
export const AddRepoDialog = lazy(() => import('../components/sidebar/AddRepoDialog'))
export const NonGitFolderDialog = lazy(() => import('../components/sidebar/NonGitFolderDialog'))
export const AddProjectFromFolderDialog = lazy(
  () => import('../components/sidebar/AddProjectFromFolderDialog')
)
export const ProjectAddedDialog = lazy(() => import('../components/sidebar/ProjectAddedDialog'))
export const DeleteWorktreeDialog = lazy(() => import('../components/sidebar/DeleteWorktreeDialog'))
export const PreservedBranchBatchReviewModal = lazy(
  () => import('../components/sidebar/PreservedBranchBatchReviewModal')
)
export const DictationController = lazy(() =>
  import('../components/dictation/DictationController').then((module) => ({
    default: module.DictationController
  }))
)
export const SshPassphraseDialog = lazy(() =>
  import('../components/settings/SshPassphraseDialog').then((module) => ({
    default: module.SshPassphraseDialog
  }))
)
export const UpdateCard = lazy(() =>
  import('../components/UpdateCard').then((module) => ({ default: module.UpdateCard }))
)
export const RemoteServerUpdateDialog = lazy(
  () => import('../components/settings/RemoteServerUpdateDialog')
)
export const ContextualTourOverlay = lazy(() =>
  import('../components/contextual-tours/ContextualTourOverlay').then((module) => ({
    default: module.ContextualTourOverlay
  }))
)
export const SetupGuideTelemetryObserver = lazy(() =>
  import('../components/setup-guide/SetupGuideTelemetryObserver').then((module) => ({
    default: module.SetupGuideTelemetryObserver
  }))
)
export const FloatingTerminalPanel = lazy(() =>
  import('../components/floating-terminal/FloatingTerminalPanel').then((module) => ({
    default: module.FloatingTerminalPanel
  }))
)
// Why: lazy so the WebP asset + overlay module aren't fetched unless the experimental flag is on.
export const PetOverlay = lazy(() => import('../components/pet/PetOverlay'))
// Why: lazy so onboarding's step modules + assets aren't fetched for users past first-launch.
export const OnboardingFlow = lazy(() => import('../components/onboarding/OnboardingFlow'))
