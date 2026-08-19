import type { OnboardingState } from '../../../shared/types'
import type { StartupSnapshot } from '../../../shared/startup-snapshot'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { getSystemPrefersDark } from '../lib/terminal-theme'
import { publishTerminalViewAttributesAtAppStart } from '../components/terminal-pane/terminal-appearance'
import { hydratePersistedUIAfterStartupRead } from '../lib/startup-ui-hydration'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '../lib/workspace-session-host-persistence'
import {
  collectFolderWorkspaceKeysFromSession,
  collectWorktreeHydrationRepoIdsFromSession
} from '../lib/workspace-session-hydration-keys'
import {
  logRendererStartupDiagnostic,
  timeRendererStartupStep,
  timeRendererStartupSyncStep
} from '../startup/startup-diagnostics'
import { useAppStore } from '../store'
import { WORKTREE_REFRESH_CONCURRENCY } from '../store/slices/worktrees'
import { awaitGitWasmReadyForStartupHydration } from '../lib/git-wasm/git-wasm-startup-gate'
import { reconnectSshTargetsForStartup } from './app-startup-ssh-reconnect'
import { recoverFromStartupHydrationFailure } from './app-startup-recovery'
import { createBootSessionApi, primeStartupSnapshot } from './app-startup-snapshot'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export type StartupHydrationActions = Pick<
  AppStoreState,
  | 'fetchOrcaProfiles'
  | 'fetchSettings'
  | 'fetchKeybindings'
  | 'setKeybindingSnapshot'
  | 'hydrateRuntimeEnvironmentStatuses'
  | 'hydratePersistedUI'
  | 'fetchReposForAllHosts'
  | 'fetchProjectGroupsForAllHosts'
  | 'fetchFolderWorkspacesForAllHosts'
  | 'fetchWorktrees'
  | 'fetchAllWorktrees'
  | 'fetchWorktreeLineage'
  | 'hydrateWorkspaceSession'
  | 'hydrateTabsSession'
  | 'hydrateEditorSession'
  | 'hydrateBrowserSession'
  | 'pruneLastVisitedTimestamps'
  | 'seedActiveWorktreeLastVisitedIfMissing'
  | 'fetchBrowserSessionProfiles'
  | 'setDeferredSshReconnectTargets'
  | 'setSshConnectionState'
  | 'reconnectPersistedTerminals'
  | 'setHydrationSucceeded'
  | 'initGitHubCache'
>

async function listRuntimeSessionHostIdsForStartup(): Promise<ExecutionHostId[]> {
  try {
    return (await window.api.runtimeEnvironments.list()).map((environment) =>
      toRuntimeExecutionHostId(environment.id)
    )
  } catch (err) {
    console.warn('Failed to list runtime session hosts for startup:', err)
    return []
  }
}

// Why (#18): the full worktree/catalog scan is not required for session recovery, so keep it off the startup-critical path.
async function refreshRemoteCatalogAfterHydration(
  actions: StartupHydrationActions,
  isCancelled: () => boolean
): Promise<void> {
  try {
    try {
      await timeRendererStartupStep('remote-catalog-refresh', async () => {
        await actions.fetchReposForAllHosts()
        await actions.fetchProjectGroupsForAllHosts()
        await actions.fetchFolderWorkspacesForAllHosts()
      })
    } catch (err) {
      console.warn('Remote startup catalog refresh failed:', err)
    }
    if (!isCancelled()) {
      try {
        await timeRendererStartupStep('remote-worktree-refresh', async () => {
          await actions.fetchAllWorktrees()
          // Why: the startup prune only saw session-referenced repos; use the deferred scan's
          // authoritative results to drop deleted-worktree visit timestamps that would
          // otherwise accumulate unbounded (disconnected SSH stays non-authoritative and is kept).
          actions.pruneLastVisitedTimestamps()
          await actions.fetchWorktreeLineage()
        })
      } catch (err) {
        console.warn('Deferred startup worktree refresh failed:', err)
      }
    }
  } finally {
    if (!isCancelled()) {
      useAppStore.setState({ startupWorktreeRefreshCompleted: true })
    }
  }
}

type StartupHydrationParams = {
  actions: StartupHydrationActions
  abortSignal: AbortSignal
  isCancelled: () => boolean
  onOnboardingLoaded: (onboarding: OnboardingState) => void
}

export async function runAppStartupHydration({
  actions,
  abortSignal,
  isCancelled,
  onOnboardingLoaded
}: StartupHydrationParams): Promise<void> {
  const startupStartedAt = performance.now()
  logRendererStartupDiagnostic('startup-chain-start')
  // Why (issue #1158): hydrate persisted UI right after ui.get() succeeds; the UI writer is gated only on persistedUIReady, so later default fallback would serialize defaults to disk.
  let uiHydrated = false
  // Why (issue #1158): track whether success-path reconnect started so the catch doesn't re-run it — re-entering on partially-mutated state would double-set ptyIds and drain pending* twice.
  let reconnectStarted = false
  try {
    // Why: the batched snapshot read (primed at module scope in main.tsx, so it
    // overlapped mount) replaces the serial per-store IPC chain; the git-wasm
    // gate joins it because every hydrate step below may run synchronous wasm
    // helpers (catalog normalizers, persisted-UI task providers, agent-resume
    // plan builders) whose pre-ready null fallback would stick in store state.
    // Both promises never reject; a null snapshot falls back per piece to the
    // individual channels, keeping today's error and recovery semantics.
    const snapshot: StartupSnapshot | null = await timeRendererStartupStep(
      'startup-snapshot-adopt',
      async () => {
        const wasmGate = awaitGitWasmReadyForStartupHydration()
        const adopted = await primeStartupSnapshot()
        await wasmGate
        return adopted
      }
    )
    // Why: the snapshot's local session partition is the EARLIEST point the
    // "will restore local terminals" answer exists — ~100ms before reconnect,
    // which stays the fallback. Warming here overlaps the multi-second aterm
    // engine cold boot with the rest of hydration. Dynamic import keeps the
    // aterm chain out of the budget-gated eager entry (same reason
    // reconnectPersistedTerminals imports it dynamically).
    if (snapshot) {
      void import('@/lib/pane-manager/aterm/aterm-session-restore-warm')
        .then((warm) => warm.warmAtermEngineForStartupSnapshot(snapshot))
        .catch(() => {
          // Best-effort: reconnect's own warm and the first pane open both
          // re-run this path and surface any real error there.
        })
    }
    // Why: nothing in the hydration chain reads profile state synchronously, so don't let it add a serial IPC round-trip before fetchSettings.
    void actions.fetchOrcaProfiles()
    // Why: repo/worktree hydration routes through settings.activeRuntimeEnvironmentId; load settings first so a persisted remote runtime doesn't hydrate stale local state.
    await timeRendererStartupStep('fetch-settings', async () => {
      if (snapshot?.settings) {
        // Why: mirrors the settings-slice fetchSettings minus the IPC read (incl. its fire-and-forget runtime health probe).
        useAppStore.setState({ settings: snapshot.settings })
        void actions.hydrateRuntimeEnvironmentStatuses()
        return
      }
      await actions.fetchSettings()
    })
    // Why: hidden-at-launch PTYs can query OSC 10/11 before any pane mounts; publish view attributes as soon as settings exist so main's silent-until-push responder has data.
    publishTerminalViewAttributesAtAppStart(useAppStore.getState().settings, getSystemPrefersDark())
    // Why: start keybindings + onboarding now so their IPC overlaps the local catalog scans; await them at their original spots. The .catch marks rejections handled if an earlier await throws first.
    // Why: browser session profiles are NOT started early — on a remote runtime the RPC may be unconnected and a failed fetch clears the list.
    const keybindingsPromise = timeRendererStartupStep('fetch-keybindings', async () => {
      if (snapshot?.keybindings) {
        actions.setKeybindingSnapshot(snapshot.keybindings)
        return
      }
      await actions.fetchKeybindings()
    })
    keybindingsPromise.catch(() => {})
    const onboardingPromise = timeRendererStartupStep('onboarding-get', () =>
      snapshot?.onboarding ? Promise.resolve(snapshot.onboarding) : window.api.onboarding.get()
    )
    onboardingPromise.catch(() => {})
    // Why: await ui.get() (not overlap) so persisted view settings hydrate before the local catalog/session steps and first paint reflects them.
    const persistedUI = await timeRendererStartupStep('ui-get', () =>
      snapshot?.ui ? Promise.resolve(snapshot.ui) : window.api.ui.get()
    )
    uiHydrated = timeRendererStartupSyncStep('hydrate-persisted-ui', () =>
      hydratePersistedUIAfterStartupRead({
        persistedUI,
        cancelled: isCancelled(),
        hydratePersistedUI: actions.hydratePersistedUI
      })
    )
    // Why: list-runtime-session-hosts reads no repo state, so overlap it with the repo scan
    // instead of paying its IPC round-trip serially before repos. .catch marks rejections handled
    // if an earlier await throws first; the value is awaited below and surfaces any error there.
    const runtimeHostsPromise = timeRendererStartupStep('list-runtime-session-hosts', () =>
      snapshot?.runtimeEnvironments
        ? Promise.resolve(
            snapshot.runtimeEnvironments.map((environment) =>
              toRuntimeExecutionHostId(environment.id)
            )
          )
        : listRuntimeSessionHostIdsForStartup()
    )
    runtimeHostsPromise.catch(() => {})
    // Why: saved remote runtimes can spend the full connect timeout; load only the local catalog for first paint and refresh remotes after hydration.
    // Snapshot rows hydrate the local catalog with ZERO round-trips (repos:list's
    // promotion/enrichment already ran main-side in the snapshot handler); any
    // missing piece falls back to the live channels, which keep those effects.
    await timeRendererStartupStep('fetch-repos-local', () =>
      actions.fetchReposForAllHosts({
        remoteHosts: 'skip',
        prefetchedLocal:
          snapshot?.repos && snapshot.projects && snapshot.projectHostSetups
            ? {
                repos: snapshot.repos,
                projects: snapshot.projects,
                projectHostSetups: snapshot.projectHostSetups
              }
            : undefined
      })
    )
    // Why: folder workspaces merge against projectGroups (repos.ts fetchFolderWorkspacesForAllHosts),
    // so keep this two-step catalog chain internally ordered; it is otherwise independent of
    // repos/worktrees/session and overlaps the session-scoped hydration chain below.
    const localCatalogChain = (async () => {
      await timeRendererStartupStep('fetch-project-groups-local', () =>
        actions.fetchProjectGroupsForAllHosts({
          remoteHosts: 'skip',
          prefetchedLocal: snapshot?.projectGroups
        })
      )
      await timeRendererStartupStep('fetch-folder-workspaces-local', () =>
        actions.fetchFolderWorkspacesForAllHosts({
          remoteHosts: 'skip',
          prefetchedLocal: snapshot?.folderWorkspaces
        })
      )
    })()
    // Why: chain session-get off runtimeHostsPromise instead of awaiting the host ids here, so the
    // catalog chain starts immediately (it needs no host ids) — awaiting the host-list IPC first
    // would re-serialize catalog hydration behind host discovery when that IPC is the slower of the
    // two. Only session-get, and the worktree hydration chained off it, wait on the ids.
    const sessionReadPromise = runtimeHostsPromise.then((startupRuntimeHostIds) =>
      // Why: include saved runtime host ids so per-host worktree session slices restore from local settings without waiting on network reachability; unreadable partitions skip.
      timeRendererStartupStep('session-get', () =>
        fetchWorkspaceSessionWithRuntimeHostOwners(
          createBootSessionApi(window.api.session, snapshot?.sessionPartitionsByHostId),
          useAppStore.getState().repos,
          startupRuntimeHostIds
        )
      )
    )
    // Why (#18): scan worktrees only for the repos the restored session references, so the
    // startup-critical scan is O(session repos) instead of O(all repos).
    const hydrationSessionChain = sessionReadPromise.then(async (sessionRead) => {
      const hydrationRepoIds = collectWorktreeHydrationRepoIdsFromSession(
        sessionRead.session,
        sessionRead.runtimeHostIdByWorkspaceSessionKey
      )
      const hydrationRepoIdSet = new Set(hydrationRepoIds)
      const hydrationRepos = useAppStore.getState().repos.filter(
        (repo) =>
          hydrationRepoIdSet.has(repo.id) &&
          // Why: disconnected SSH repos hydrate from local metadata; only runtime-owned repos use placeholders.
          parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'
      )
      await timeRendererStartupStep('fetch-hydration-worktrees', () =>
        mapWithConcurrency(hydrationRepos, WORKTREE_REFRESH_CONCURRENCY, (repo) =>
          actions.fetchWorktrees(repo.id, { ownerHostId: getRepoExecutionHostId(repo) })
        )
      )
      return sessionRead
    })
    // Why (#18 review): join on allSettled, NOT fail-fast Promise.all. A fast rejection from one branch
    // would drop into the catch/recovery path (which reconnects terminals and flips readiness) while a
    // sibling hydration task is still in flight and mutating catalog/worktree state — the old serial flow
    // guaranteed no hydration step ran during recovery. Wait for both writers to settle, then surface the
    // first rejection so recovery still triggers, but only once nothing is left writing to the store.
    const [sessionOutcome, catalogOutcome] = await Promise.allSettled([
      hydrationSessionChain,
      localCatalogChain
    ])
    if (sessionOutcome.status === 'rejected') {
      throw sessionOutcome.reason
    }
    if (catalogOutcome.status === 'rejected') {
      throw catalogOutcome.reason
    }
    const sessionRead = sessionOutcome.value
    await keybindingsPromise
    if (isCancelled()) {
      return
    }

    const sessionHydrationOptions = {
      additionalValidWorkspaceKeys: collectFolderWorkspaceKeysFromSession(sessionRead.session)
    }
    timeRendererStartupSyncStep('hydrate-session-stores', () => {
      actions.hydrateWorkspaceSession(sessionRead.session, {
        ...sessionHydrationOptions,
        runtimeHostIdByWorkspaceSessionKey: sessionRead.runtimeHostIdByWorkspaceSessionKey
      })
      actions.hydrateTabsSession(sessionRead.session, sessionHydrationOptions)
      actions.hydrateEditorSession(sessionRead.session, sessionHydrationOptions)
      actions.hydrateBrowserSession(sessionRead.session, sessionHydrationOptions)
    })
    // Why: prune visit timestamps AFTER hydration (earlier, worktreesByRepo may be empty and prune would drop entries for worktrees about to appear); seed the active worktree if missing.
    // See docs/cmd-j-empty-query-ordering.md.
    timeRendererStartupSyncStep('visit-timestamp-prune', () => {
      actions.pruneLastVisitedTimestamps()
      actions.seedActiveWorktreeLastVisitedIfMissing()
    })
    // Why: snapshot.browserSessionProfiles stays unused until the browser slice
    // can adopt it — the action routes remote-runtime hosts through RPC and owns
    // the per-host list merge, so bypassing it would change those semantics.
    await timeRendererStartupStep('fetch-browser-session-profiles', () =>
      actions.fetchBrowserSessionProfiles()
    )
    const onboardingState = await onboardingPromise
    if (!isCancelled()) {
      onOnboardingLoaded(onboardingState)
    }

    await reconnectSshTargetsForStartup({
      activeConnectionIdsAtShutdown: sessionRead.session.activeConnectionIdsAtShutdown,
      setDeferredSshReconnectTargets: actions.setDeferredSshReconnectTargets,
      setSshConnectionState: actions.setSshConnectionState
    })

    // Why: main overlaps daemon/hook startup with hydration, but restored terminals need those services ready before they spawn/reconnect PTYs.
    await timeRendererStartupStep('first-window-services-await', () =>
      window.api.app.awaitFirstWindowStartupServices()
    )
    reconnectStarted = true
    await timeRendererStartupStep('reconnect-terminals', () =>
      actions.reconnectPersistedTerminals(abortSignal)
    )
    syncZoomCSSVar()
    // Why (issue #1158): unlock the session writer only after hydration and all dependent steps succeeded, so a mid-startup throw can't serialize partially-mutated state to disk.
    actions.setHydrationSucceeded(true)
    logRendererStartupDiagnostic('startup-hydration-done', {
      durationMs: Math.round(performance.now() - startupStartedAt)
    })
    void refreshRemoteCatalogAfterHydration(actions, isCancelled)
  } catch (error) {
    await recoverFromStartupHydrationFailure({
      error,
      uiHydrated,
      reconnectStarted,
      abortSignal,
      isCancelled,
      hydratePersistedUI: actions.hydratePersistedUI,
      reconnectPersistedTerminals: actions.reconnectPersistedTerminals
    })
  }
  void actions.initGitHubCache()
}
