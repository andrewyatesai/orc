import { app, ipcMain } from 'electron'
import { STARTUP_SNAPSHOT_CHANNEL, type StartupSnapshot } from '../../shared/startup-snapshot'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { listKnownRuntimeHostIds } from '../../shared/workspace-session-runtime-hosts'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { runRepoListSideEffectsForStartupSnapshot } from './repo-list-boot-side-effects'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { Store } from '../persistence'

// Why: mirrors the browser:session:listProfiles sender gate — profile data is
// only handed to the main-window renderer. Mutable because macOS re-activation
// re-runs registerCoreHandlers with a new window's webContents id.
let trustedWebContentsId: number | null = null

export function setTrustedStartupSnapshotWebContentsId(webContentsId: number | null): void {
  trustedWebContentsId = webContentsId
}

function listPublicRuntimeEnvironmentsForSnapshot(): PublicKnownRuntimeEnvironment[] {
  try {
    return listEnvironments(app.getPath('userData')).map(redactRuntimeEnvironment)
  } catch (err) {
    console.warn('[startup-snapshot] runtime environment listing failed:', err)
    return []
  }
}

/** One boot invoke replacing the renderer's serial chain of per-store reads.
 *  Every source is the same synchronous in-memory getter its individual
 *  channel uses; those channels stay registered for non-boot callers.
 *
 *  The boot chain consumes this catalog with ZERO repos:list round-trips, so
 *  repos:list's promotion/enrichment side effects (issue #8125 folder→git
 *  promotion, git-identity + username enrichment) replay here through the seam
 *  registerRepoHandlers installs — before repos are read, so promotions land
 *  in this payload exactly as a repos:list response would carry them. The one
 *  part that can spawn git (promotion's rev-parse probe for an ambiguous `.git`
 *  marker) is scheduled off this handler by the seam and converges through
 *  repos:changed, so no consumer of this payload waits on a subprocess. */
export function registerStartupSnapshotHandler(
  store: Store,
  keybindings?: KeybindingService
): void {
  ipcMain.handle(STARTUP_SNAPSHOT_CHANNEL, (event): StartupSnapshot => {
    runRepoListSideEffectsForStartupSnapshot()
    const repos = store.getRepos()
    const runtimeEnvironments = listPublicRuntimeEnvironmentsForSnapshot()
    const sessionPartitionsByHostId: Partial<
      Record<ExecutionHostId, ReturnType<Store['getWorkspaceSession']>>
    > = {
      [LOCAL_EXECUTION_HOST_ID]: store.getWorkspaceSession()
    }
    // Why: saved runtime environments plus runtime-owned repo rows are the same
    // partition set the renderer's boot session merge enumerates.
    const runtimeHostIds = new Set<ExecutionHostId>([
      ...listKnownRuntimeHostIds(repos),
      ...runtimeEnvironments.map((environment) => toRuntimeExecutionHostId(environment.id))
    ])
    for (const hostId of runtimeHostIds) {
      try {
        sessionPartitionsByHostId[hostId] = store.getWorkspaceSession(hostId)
      } catch (err) {
        // Why: fail-soft like session:get — the renderer skips unreadable partitions.
        console.warn(`[startup-snapshot] skipping unreadable session partition ${hostId}:`, err)
      }
    }
    return {
      settings: store.getSettings(),
      ui: store.getUI(),
      keybindings: keybindings?.getSnapshot(),
      onboarding: store.getOnboarding(),
      repos,
      projects: store.getProjects(),
      projectHostSetups: store.getProjectHostSetups(),
      projectGroups: store.getProjectGroups(),
      folderWorkspaces: store.getFolderWorkspaces(),
      runtimeEnvironments,
      sessionPartitionsByHostId,
      browserSessionProfiles:
        trustedWebContentsId != null && event.sender.id === trustedWebContentsId
          ? browserSessionRegistry.listProfiles()
          : undefined
    }
  })
}
