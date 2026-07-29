import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import { reconnectSshTargetForRendererStartup } from '../startup/ssh-startup-reconnect'
import {
  logRendererStartupDiagnostic,
  timeRendererStartupStep
} from '../startup/startup-diagnostics'
import type { useAppStore } from '../store'

type AppStoreState = ReturnType<typeof useAppStore.getState>

const SSH_RECONNECT_TIMEOUT_MS = 15_000

type StartupSshReconnectParams = {
  activeConnectionIdsAtShutdown: string[] | undefined
  setDeferredSshReconnectTargets: AppStoreState['setDeferredSshReconnectTargets']
  setSshConnectionState: AppStoreState['setSshConnectionState']
}

// Why: re-establish SSH before terminal reconnect so SSH-backed tabs route through pty.attach; passphrase targets defer to tab focus to avoid stacked credential dialogs.
export async function reconnectSshTargetsForStartup({
  activeConnectionIdsAtShutdown,
  setDeferredSshReconnectTargets,
  setSshConnectionState
}: StartupSshReconnectParams): Promise<void> {
  // Why: never dial runtime-owned (ephemeral-VM) targets from the renderer — ssh.connect would dispose the runtime layer's live relay session.
  const connectionIds = (activeConnectionIdsAtShutdown ?? []).filter(
    (targetId) => !isRuntimeOwnedSshTargetId(targetId)
  )
  if (connectionIds.length === 0) {
    logRendererStartupDiagnostic('ssh-reconnect-skipped', { connectionIds: 0 })
    return
  }

  try {
    const allTargets = await timeRendererStartupStep('ssh-list-targets', () =>
      window.api.ssh.listTargets()
    )
    const targetMap = new Map(allTargets.map((t) => [t.id, t]))
    const targets = connectionIds.map((targetId) => ({
      targetId,
      needsPassphrase: targetMap.get(targetId)?.lastRequiredPassphrase ?? false
    }))

    const eagerTargets = targets.filter((t) => !t.needsPassphrase)
    const deferredTargets = targets.filter((t) => t.needsPassphrase)

    if (deferredTargets.length > 0) {
      setDeferredSshReconnectTargets(deferredTargets.map((t) => t.targetId))
    }

    // Why: treat timed-out eager targets as deferred so their PTYs reattach on tab focus (ssh.connect keeps running in main and likely finishes by then).
    const timedOutTargets: string[] = []
    await timeRendererStartupStep(
      'ssh-reconnect',
      () =>
        Promise.all(
          eagerTargets.map(async ({ targetId }) => {
            const result = await reconnectSshTargetForRendererStartup({
              targetId,
              timeoutMs: SSH_RECONNECT_TIMEOUT_MS,
              connect: (id) => window.api.ssh.connect({ targetId: id }),
              publishState: setSshConnectionState,
              onFailure: (id, error) => {
                console.warn(`SSH auto-reconnect failed for ${id}:`, error)
              }
            })
            if (result.timedOut) {
              timedOutTargets.push(targetId)
            }
          })
        ),
      {
        eagerTargets: eagerTargets.length,
        deferredTargets: deferredTargets.length
      }
    )
    if (timedOutTargets.length > 0) {
      setDeferredSshReconnectTargets([
        ...deferredTargets.map((t) => t.targetId),
        ...timedOutTargets
      ])
    }

    // Why: older/wrapped providers may return no state from connect; poll main once as a compatibility fallback before terminal restoration.
    for (const { targetId } of eagerTargets) {
      if (timedOutTargets.includes(targetId)) {
        continue
      }
      try {
        const state = await window.api.ssh.getState({ targetId })
        console.warn(`[ssh-restore] Polled state for ${targetId}: status=${state?.status}`)
        if (state?.status === 'connected') {
          setSshConnectionState(targetId, state)
        }
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    console.warn('SSH startup reconnect failed:', err)
  }
}
