import type { RemoteWorkspacePatchResult } from '../../../shared/remote-workspace-types'
import type { UpdateStatus } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../store'

export function applyRemoteWorkspacePatchStatus(
  targetId: string,
  result: RemoteWorkspacePatchResult
): void {
  const store = useAppStore.getState()
  if (result.ok) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.App.332dbfa497', 'Workspace uploaded')
    })
    return
  }
  store.setRemoteWorkspaceSyncStatus(targetId, {
    phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
    direction: 'push',
    revision: result.snapshot?.revision,
    updatedAt: result.snapshot?.updatedAt,
    lastSyncedAt: Date.now(),
    message:
      result.message ??
      (result.reason === 'stale-revision'
        ? 'Workspace changed on another device'
        : 'Remote workspace sync unavailable')
  })
}

export function shouldMountUpdateCardForStatus(status: UpdateStatus): boolean {
  if (status.state === 'idle') {
    return false
  }
  if (status.state === 'checking' || status.state === 'not-available') {
    return status.userInitiated === true
  }
  return true
}
