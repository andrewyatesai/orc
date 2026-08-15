import { Suspense } from 'react'
import { translate } from '@/i18n/i18n'
import { CrashReportDialog } from '../components/crash-report/CrashReportDialog'
import { DaemonStatusToastBridge } from '../components/daemon-status/DaemonStatusToastBridge'
import { MarkdownTemplatePicker } from '../components/editor/MarkdownTemplatePicker'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import NewWorkspaceComposerModal from '../components/NewWorkspaceComposerModal'
import { SkillFreshnessUpdateDialog } from '../components/skills/SkillFreshnessUpdateDialog'
import { StarNagCard } from '../components/StarNagCard'
import { StarNagAgentValueMomentObserver } from '../components/star-nag/StarNagAgentValueMomentObserver'
import { StarNagToastHost } from '../components/star-nag/StarNagToastHost'
import RecentTabSwitcher from '../components/tab-bar/RecentTabSwitcher'
import { TelemetryFirstLaunchSurface } from '../components/TelemetryFirstLaunchSurface'
import { ZoomOverlay } from '../components/ZoomOverlay'
import type { LazyModalId } from '../lazy-modal-mount-state'
import type { OnboardingState } from '../../../shared/types'
import type { useAppStore } from '../store'
import {
  AddProjectFromFolderDialog,
  AddRepoDialog,
  ContextualTourOverlay,
  DeleteWorktreeDialog,
  DictationController,
  FeatureTipsModal,
  FeatureWallModal,
  FederatedSearchPalette,
  NonGitFolderDialog,
  OnboardingFlow,
  PetOverlay,
  PreservedBranchBatchReviewModal,
  ProjectAddedDialog,
  QuickOpen,
  RemoteServerUpdateDialog,
  SetupGuideModal,
  SetupGuideTelemetryObserver,
  SshPassphraseDialog,
  UpdateCard,
  WorkspaceCleanupDialog,
  WorktreeJumpPalette
} from './app-lazy-surfaces'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type AppOverlayHostProps = {
  activeModal: AppStoreState['activeModal']
  activeView: AppStoreState['activeView']
  settings: AppStoreState['settings']
  mountedLazyModalIds: ReadonlySet<LazyModalId>
  shouldMountAddRepoDialog: boolean
  shouldMountSetupGuideTelemetryObserver: boolean
  shouldMountContextualTourOverlay: boolean
  shouldMountUpdateCard: boolean
  shouldMountDictationController: boolean
  renderPetOverlay: boolean
  petVisible: boolean
  hasSshCredentialRequest: boolean
  onboarding: OnboardingState | null
  shouldRenderOnboarding: boolean
  onOnboardingChange: (onboarding: OnboardingState) => void
}

export function AppOverlayHost({
  activeModal,
  activeView,
  settings,
  mountedLazyModalIds,
  shouldMountAddRepoDialog,
  shouldMountSetupGuideTelemetryObserver,
  shouldMountContextualTourOverlay,
  shouldMountUpdateCard,
  shouldMountDictationController,
  renderPetOverlay,
  petVisible,
  hasSshCredentialRequest,
  onboarding,
  shouldRenderOnboarding,
  onOnboardingChange
}: AppOverlayHostProps): React.JSX.Element {
  return (
    <>
      {/* Why: keep in the entry bundle so a stale/corrupt lazy chunk can't strand users at Create. */}
      {activeModal === 'new-workspace-composer' ? (
        <RecoverableRenderErrorBoundary
          boundaryId="modal.new-workspace-composer"
          surface="modal"
          resetKey
          compact
        >
          <NewWorkspaceComposerModal />
        </RecoverableRenderErrorBoundary>
      ) : null}
      <Suspense fallback={null}>
        {shouldMountAddRepoDialog ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.add-repo"
            surface="modal"
            resetKey={activeModal === 'add-repo'}
            compact
          >
            <AddRepoDialog />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {/* Why: Settings can start Add Project without Sidebar, so its handoff dialogs must share the root host. */}
        {activeModal === 'confirm-non-git-folder' ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.confirm-non-git-folder"
            surface="modal"
            resetKey
            compact
          >
            <NonGitFolderDialog />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {activeModal === 'confirm-add-project-from-folder' ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.confirm-add-project-from-folder"
            surface="modal"
            resetKey
            compact
          >
            <AddProjectFromFolderDialog />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {activeModal === 'project-added' ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.project-added"
            surface="modal"
            resetKey
            compact
          >
            <ProjectAddedDialog />
          </RecoverableRenderErrorBoundary>
        ) : null}
      </Suspense>
      {/* Why: root overlays can render Radix <Tooltip>s; keep inside the shared provider so lazy surfaces mount from any entry point. */}
      <Suspense fallback={null}>
        {mountedLazyModalIds.has('workspace-cleanup') ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.workspace-cleanup"
            surface="modal"
            resetKey={activeModal === 'workspace-cleanup'}
            compact
          >
            <WorkspaceCleanupDialog />
          </RecoverableRenderErrorBoundary>
        ) : null}
      </Suspense>
      <Suspense fallback={null}>
        {mountedLazyModalIds.has('quick-open') ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.quick-open"
            surface="modal"
            resetKey={activeModal === 'quick-open'}
            compact
          >
            <QuickOpen />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {mountedLazyModalIds.has('federated-search') ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.federated-search"
            surface="modal"
            resetKey={activeModal === 'federated-search'}
            compact
          >
            <FederatedSearchPalette />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {mountedLazyModalIds.has('worktree-palette') ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.worktree-palette"
            surface="modal"
            resetKey={activeModal === 'worktree-palette'}
            compact
          >
            <WorktreeJumpPalette />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {mountedLazyModalIds.has('setup-guide') ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.setup-guide"
            surface="modal"
            resetKey={activeModal === 'setup-guide'}
            compact
          >
            <SetupGuideModal />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {mountedLazyModalIds.has('feature-wall') ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.feature-wall"
            surface="modal"
            resetKey={activeModal === 'feature-wall'}
            compact
          >
            <FeatureWallModal />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {mountedLazyModalIds.has('feature-tips') ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.feature-tips"
            surface="modal"
            resetKey={activeModal === 'feature-tips'}
            compact
          >
            <FeatureTipsModal />
          </RecoverableRenderErrorBoundary>
        ) : null}
      </Suspense>
      {shouldMountSetupGuideTelemetryObserver ? (
        <Suspense fallback={null}>
          <SetupGuideTelemetryObserver />
        </Suspense>
      ) : null}
      {shouldMountContextualTourOverlay ? (
        <Suspense fallback={null}>
          <ContextualTourOverlay />
        </Suspense>
      ) : null}
      {/* Why: mount only after UI hydration, else a hidden pet flashes while the store still holds default visibility. */}
      {renderPetOverlay ? (
        <Suspense fallback={null}>
          <RecoverableRenderErrorBoundary
            boundaryId="overlay.pet"
            surface="overlay"
            resetKey={petVisible}
            compact
          >
            <PetOverlay />
          </RecoverableRenderErrorBoundary>
        </Suspense>
      ) : null}
      {shouldMountUpdateCard ? (
        <Suspense fallback={null}>
          <RecoverableRenderErrorBoundary
            boundaryId="overlay.update-card"
            surface="overlay"
            resetKey={activeView}
            compact
          >
            <UpdateCard />
          </RecoverableRenderErrorBoundary>
        </Suspense>
      ) : null}
      <RecoverableRenderErrorBoundary
        boundaryId="overlay.star-nag"
        surface="overlay"
        resetKey={activeView}
        compact
      >
        <StarNagCard />
      </RecoverableRenderErrorBoundary>
      <RecoverableRenderErrorBoundary
        boundaryId="overlay.star-nag-toast"
        surface="overlay"
        resetKey={activeView}
        compact
      >
        <StarNagToastHost />
      </RecoverableRenderErrorBoundary>
      <StarNagAgentValueMomentObserver />
      {/* Why: daemon degradation/failure must be loud once (sticky toast) — see
          docs/reference/daemon-staleness-ux.md §Phase 2. Mounted at App root so the status
          subscription lives once per renderer session. */}
      <DaemonStatusToastBridge />
      {/* Why: mount at App root to render once per session; internal cohort gate limits it to pre-telemetry users — see telemetry-plan.md §First-launch experience. */}
      <RecoverableRenderErrorBoundary
        boundaryId="overlay.telemetry-first-launch"
        surface="overlay"
        resetKey={settings?.telemetry?.optedIn ?? 'unknown'}
        compact
      >
        <TelemetryFirstLaunchSurface />
      </RecoverableRenderErrorBoundary>
      <RecoverableRenderErrorBoundary
        boundaryId="overlay.zoom"
        surface="overlay"
        resetKey={activeView}
        compact
      >
        <ZoomOverlay />
      </RecoverableRenderErrorBoundary>
      <Suspense fallback={null}>
        {activeModal === 'delete-worktree' ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.delete-worktree"
            surface="modal"
            resetKey
            compact
          >
            <DeleteWorktreeDialog />
          </RecoverableRenderErrorBoundary>
        ) : null}
        {activeModal === 'preserved-branch-review' ? (
          <RecoverableRenderErrorBoundary
            boundaryId="modal.preserved-branch-review"
            surface="modal"
            resetKey
            compact
          >
            <PreservedBranchBatchReviewModal />
          </RecoverableRenderErrorBoundary>
        ) : null}
      </Suspense>
      {hasSshCredentialRequest ? (
        <Suspense fallback={null}>
          <RecoverableRenderErrorBoundary
            boundaryId="modal.ssh-passphrase"
            surface="modal"
            resetKey={activeModal}
            compact
          >
            <SshPassphraseDialog />
          </RecoverableRenderErrorBoundary>
        </Suspense>
      ) : null}
      <RecoverableRenderErrorBoundary
        boundaryId="modal.markdown-template-picker"
        surface="modal"
        resetKey={activeModal}
        compact
      >
        <MarkdownTemplatePicker />
      </RecoverableRenderErrorBoundary>
      <RecoverableRenderErrorBoundary
        boundaryId="modal.crash-report"
        surface="modal"
        reportAsCrash={false}
        resetKey={activeModal}
        compact
        title={translate('auto.App.722d03aa62', 'The crash report dialog hit an error.')}
        description={translate(
          'auto.App.acd66311dc',
          'Use the Help menu after retrying if you still need diagnostics.'
        )}
      >
        <CrashReportDialog />
      </RecoverableRenderErrorBoundary>
      {onboarding && shouldRenderOnboarding ? (
        <Suspense fallback={null}>
          <RecoverableRenderErrorBoundary
            boundaryId="modal.onboarding"
            surface="modal"
            title={translate('auto.App.f02d37278a', 'Onboarding hit an error.')}
            description={translate(
              'auto.App.221a95ba38',
              'Retry onboarding or close it and continue in the app.'
            )}
          >
            <OnboardingFlow onboarding={onboarding} onOnboardingChange={onOnboardingChange} />
          </RecoverableRenderErrorBoundary>
        </Suspense>
      ) : null}
      {shouldMountDictationController ? (
        <Suspense fallback={null}>
          <RecoverableRenderErrorBoundary
            boundaryId="overlay.dictation"
            surface="overlay"
            resetKey={activeView}
            compact
          >
            <DictationController />
          </RecoverableRenderErrorBoundary>
        </Suspense>
      ) : null}
      <RecoverableRenderErrorBoundary
        boundaryId="overlay.recent-tab-switcher"
        surface="overlay"
        resetKey={activeView}
        compact
      >
        <RecentTabSwitcher />
      </RecoverableRenderErrorBoundary>
      {/* Why: hosts a live terminal pane needing the link-routing preference context; mounting outside crashes it. */}
      <RecoverableRenderErrorBoundary
        boundaryId="overlay.skill-freshness-update-dialog"
        surface="overlay"
        compact
      >
        <SkillFreshnessUpdateDialog />
      </RecoverableRenderErrorBoundary>
      <Suspense fallback={null}>
        <RecoverableRenderErrorBoundary
          boundaryId="overlay.remote-server-update-dialog"
          surface="overlay"
          compact
        >
          <RemoteServerUpdateDialog />
        </RecoverableRenderErrorBoundary>
      </Suspense>
    </>
  )
}
