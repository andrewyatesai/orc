import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { StartupSnapshot } from '../../../shared/startup-snapshot'
import type { WorkspaceSessionState } from '../../../shared/types'

// Why: the batched channel needs a preload passthrough that may not be exposed
// yet (web serve never exposes it); feature-detect instead of typing it in.
type BatchedStartupApi = typeof window.api & {
  startup?: { getSnapshot?: () => Promise<StartupSnapshot> }
}

type BootSessionApi = { get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState> }

let snapshotPromise: Promise<StartupSnapshot | null> | null = null

/** Module-scope singleton for the boot snapshot fetch. Primed from main.tsx
 *  before createRoot so the read overlaps wasm compile + React mount; the
 *  hydration chain adopts the same promise (StrictMode's double-effect and any
 *  re-run reuse it — the underlying fetch happens once per renderer process).
 *
 *  Never rejects: a failed or unavailable snapshot resolves null and every
 *  consumer falls back to its individual channel, so errors still surface on
 *  the exact code paths the recovery flow owns today. */
export function primeStartupSnapshot(): Promise<StartupSnapshot | null> {
  snapshotPromise ??= fetchStartupSnapshot()
  return snapshotPromise
}

export function resetStartupSnapshotForTest(): void {
  snapshotPromise = null
}

async function fetchStartupSnapshot(): Promise<StartupSnapshot | null> {
  const api = window.api as BatchedStartupApi | undefined
  if (!api) {
    return null
  }
  const getSnapshot = api.startup?.getSnapshot
  if (getSnapshot) {
    try {
      return await getSnapshot()
    } catch (err) {
      console.warn('[startup] batched snapshot fetch failed; using individual channels:', err)
      return null
    }
  }
  return assembleSnapshotFromIndividualChannels(api)
}

/** Fallback when the batched channel is not exposed (older preload, web serve):
 *  fire the same boot reads in parallel instead of the serial chain. A piece
 *  that fails resolves undefined, and hydration re-runs that piece's original
 *  read so its error semantics (including recovery) are unchanged. */
async function assembleSnapshotFromIndividualChannels(
  api: BatchedStartupApi
): Promise<StartupSnapshot> {
  const piece = async <T>(read: (() => Promise<T>) | undefined): Promise<T | undefined> => {
    try {
      return read ? await read() : undefined
    } catch {
      return undefined
    }
  }
  const runtimeEnvironmentsPromise = piece(() => api.runtimeEnvironments.list())
  const sessionPartitionsPromise = (async (): Promise<
    StartupSnapshot['sessionPartitionsByHostId']
  > => {
    const partitions: StartupSnapshot['sessionPartitionsByHostId'] = {}
    const local = await piece(() => api.session.get())
    if (local) {
      partitions[LOCAL_EXECUTION_HOST_ID] = local
    }
    // Why: saved runtime hosts are known before the repo catalog hydrates;
    // repo-derived hosts fall back to session:get via the boot session api.
    const environments = (await runtimeEnvironmentsPromise) ?? []
    await Promise.all(
      environments.map(async (environment) => {
        const hostId = toRuntimeExecutionHostId(environment.id)
        const partition = await piece(() => api.session.get(hostId))
        if (partition) {
          partitions[hostId] = partition
        }
      })
    )
    return partitions
  })()
  const [settings, ui, keybindings, onboarding, runtimeEnvironments, sessionPartitionsByHostId] =
    await Promise.all([
      piece(() => api.settings.get()),
      piece(() => api.ui.get()),
      piece(api.keybindings ? () => api.keybindings.get() : undefined),
      piece(() => api.onboarding.get()),
      runtimeEnvironmentsPromise,
      sessionPartitionsPromise
    ])
  return { settings, ui, keybindings, onboarding, runtimeEnvironments, sessionPartitionsByHostId }
}

/** Session api the boot merge reads through: snapshot partitions answer
 *  instantly, anything the snapshot missed falls back to live session:get. */
export function createBootSessionApi(
  live: BootSessionApi,
  partitions: StartupSnapshot['sessionPartitionsByHostId']
): BootSessionApi {
  if (!partitions) {
    return live
  }
  return {
    get: (hostId) => {
      const partition = partitions[hostId ?? LOCAL_EXECUTION_HOST_ID]
      return partition ? Promise.resolve(partition) : live.get(hostId)
    }
  }
}
