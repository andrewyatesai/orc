import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { registerRuntimeHostPtyBindingChurnPruneStore } from '../runtime-host-pty-binding-churn-prune'
import {
  registerRuntimeEnvironmentConnectivityHandlers,
  registerRuntimeEnvironmentPassiveHandlers
} from './runtime-environment-connectivity-handlers'
import { closeRemoteRuntimeRequestConnection } from './runtime-environment-request-connections'
import { registerRuntimeEnvironmentRecoveryHandler } from './runtime-environment-recovery-handler'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import {
  closeSubscriptionsForEnvironment,
  registerRuntimeEnvironmentSubscriptionHandlers
} from './runtime-environment-subscriptions'
import {
  clearSharedControlSupport,
  resetSharedControlSupport
} from './runtime-environment-transport-routing'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'

const getUserDataPath = (): string => app.getPath('userData')

export function invalidateRuntimeEnvironmentTransport(environmentId: string): void {
  // Why: a same-id re-pair must retire every transport that still authenticates as the old peer.
  advanceRuntimeEnvironmentTransportGeneration(environmentId)
  closeRemoteRuntimeRequestConnection(environmentId)
  clearSharedControlSupport(environmentId)
  closeSubscriptionsForEnvironment(environmentId)
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

  registerRuntimeEnvironmentConnectivityHandlers({
    store,
    getUserDataPath,
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerRuntimeEnvironmentRecoveryHandler()
  registerRuntimeEnvironmentPassiveHandlers(getUserDataPath)
  registerRuntimeEnvironmentSubscriptionHandlers()
}
