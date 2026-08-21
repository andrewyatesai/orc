import { app, ipcMain } from 'electron'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { Store } from '../persistence'
import { registerRuntimeHostPtyBindingChurnPruneStore } from '../runtime-host-pty-binding-churn-prune'
import { runtimeEnvironmentCallFailure } from './runtime-environment-call-failure'
import { closeRemoteRuntimeRequestConnection } from './runtime-environment-request-connections'
import { registerRuntimeEnvironmentRecoveryHandler } from './runtime-environment-recovery-handler'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import {
  closeSubscriptionsForEnvironment,
  registerRuntimeEnvironmentSubscriptionHandlers
} from './runtime-environment-subscriptions'
import {
  callRuntimeEnvironment,
  clearSharedControlSupport,
  getRuntimeEnvironmentStatus,
  resetSharedControlSupport
} from './runtime-environment-transport-routing'

const RUNTIME_ENVIRONMENT_HANDLER_CHANNELS = [
  'runtimeEnvironments:list',
  'runtimeEnvironments:addFromPairingCode',
  'runtimeEnvironments:resolve',
  'runtimeEnvironments:remove',
  'runtimeEnvironments:disconnect',
  'runtimeEnvironments:getStatus',
  'runtimeEnvironments:call',
  'runtimeEnvironments:subscribe',
  'runtimeEnvironments:unsubscribe'
] as const

const getUserDataPath = (): string => app.getPath('userData')

export function invalidateRuntimeEnvironmentTransport(environmentId: string): void {
  // Why: a same-id re-pair must retire every transport that still authenticates as the old peer.
  advanceRuntimeEnvironmentTransportGeneration(environmentId)
  closeRemoteRuntimeRequestConnection(environmentId)
  clearSharedControlSupport(environmentId)
  closeSubscriptionsForEnvironment(environmentId)
}

function listPublicRuntimeEnvironments(): PublicKnownRuntimeEnvironment[] {
  // Why: a corrupt VM store must not break persisted environment listing.
  return listEnvironments(getUserDataPath()).map(redactRuntimeEnvironment)
}

export function registerRuntimeEnvironmentHandlers(store: Store): void {
  // Why: transport routing detects runtimeId churn but cannot import the Store;
  // hand it the persistence hook here so churn prunes stale PTY bindings (#9352).
  registerRuntimeHostPtyBindingChurnPruneStore(store)
  // Why: keep direct re-registration safe even though register-core-handlers
  // normally guards this path; otherwise the binary send listener can stack.
  resetSharedControlSupport()
  for (const channel of RUNTIME_ENVIRONMENT_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('runtimeEnvironments:subscriptionBinary')

  ipcMain.handle('runtimeEnvironments:list', listPublicRuntimeEnvironments)
  ipcMain.handle(
    'runtimeEnvironments:addFromPairingCode',
    (
      _event,
      args: { name: string; pairingCode: string }
    ): { environment: PublicKnownRuntimeEnvironment } => ({
      environment: redactRuntimeEnvironment(addEnvironmentFromPairingCode(getUserDataPath(), args))
    })
  )
  ipcMain.handle('runtimeEnvironments:resolve', (_event, args: { selector: string }) =>
    redactRuntimeEnvironment(resolveEnvironment(getUserDataPath(), args.selector))
  )
  ipcMain.handle(
    'runtimeEnvironments:remove',
    (_event, args: { selector: string }): { removed: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (store.getSettings().activeRuntimeEnvironmentId === environment.id) {
        throw new Error('Choose another Active Server in Advanced before removing this server.')
      }
      const removed = removeEnvironment(getUserDataPath(), args.selector)
      invalidateRuntimeEnvironmentTransport(removed.id)
      if (args.selector !== removed.id) {
        closeRemoteRuntimeRequestConnection(args.selector)
        clearSharedControlSupport(args.selector)
      }
      // Why: drop the persisted terminal host partition so a later boot never
      // restores tabs that resubscribe against the now-removed environment and
      // flood 'Unknown environment'. Key on removed.id (the canonical env id):
      // partitions live under runtime:<envId>, never the selector alias.
      store.deleteHostWorkspaceSession(toRuntimeExecutionHostId(removed.id))
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    (_event, args: { selector: string }): { disconnected: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      // Why: disconnect is intentionally non-destructive; it drops live
      // transport state while keeping the paired server available for later.
      invalidateRuntimeEnvironmentTransport(environment.id)
      if (args.selector !== environment.id) {
        closeRemoteRuntimeRequestConnection(args.selector)
        clearSharedControlSupport(args.selector)
      }
      return { disconnected: redactRuntimeEnvironment(environment) }
    }
  )
  registerRuntimeEnvironmentRecoveryHandler()
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      return getRuntimeEnvironmentStatus(getUserDataPath(), args.selector, args.timeoutMs)
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      _event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      // Why: a typed client/queue rejection thrown here loses its code crossing
      // IPC; hand it back as a structured failure so the code reaches the
      // renderer's classification instead of a code-less English message (#12667).
      try {
        return await callRuntimeEnvironment(
          getUserDataPath(),
          args.selector,
          args.method,
          args.params,
          args.timeoutMs,
          args.expectedEnvironmentPairingRevision
        )
      } catch (error) {
        const failure = runtimeEnvironmentCallFailure(args.method, error)
        if (failure) {
          return failure
        }
        throw error
      }
    }
  )
  registerRuntimeEnvironmentSubscriptionHandlers()
}
