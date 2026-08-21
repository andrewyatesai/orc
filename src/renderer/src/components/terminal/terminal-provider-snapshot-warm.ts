import type { AppState } from '../../store/types'
import {
  collectTerminalProviderSnapshotPtyIds,
  synchronizeTerminalProviderSnapshotCapabilities
} from './terminal-provider-snapshot-capability'

/** Warm the PTY snapshot-capability route cache from full store state — including
 *  pending-reconnect and layout-leaf ptyIds the per-workspace hook never sees. */
export async function warmTerminalProviderSnapshotCapabilities(state: AppState): Promise<void> {
  await synchronizeTerminalProviderSnapshotCapabilities(
    collectTerminalProviderSnapshotPtyIds(state)
  )
}
