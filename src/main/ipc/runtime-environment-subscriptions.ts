import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  environmentId: string
  ownerWebContentsId: number
  removeLifecycleListeners: () => void
}
const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
const getUserDataPath = (): string => app.getPath('userData')

export function closeSubscriptionsForEnvironment(environmentId: string): void {
  // Why: removed runtimes must not retain terminal/browser WebSockets until renderer teardown.
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    remoteRuntimeSubscriptions.delete(subscriptionId)
    subscription.close()
  }
}

export function registerRuntimeEnvironmentSubscriptionHandlers(): void {
  ipcMain.handle(
    'runtimeEnvironments:subscribe',
    async (
      event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        subscriptionId?: string
        expectedEnvironmentPairingRevision?: number
      }
    ): Promise<{ subscriptionId: string; requestId: string }> => {
      const subscriptionId =
        typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
          ? args.subscriptionId
          : randomUUID()
      if (remoteRuntimeSubscriptions.has(subscriptionId)) {
        throw new Error('Runtime environment subscription id already exists')
      }
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      const pairingRevision = environment.pairingRevision ?? environment.createdAt
      if (
        args.expectedEnvironmentPairingRevision !== undefined &&
        pairingRevision !== args.expectedEnvironmentPairingRevision
      ) {
        throw new Error('Runtime environment pairing changed; refresh and try again')
      }
      const transportGeneration = getRuntimeEnvironmentTransportGeneration(environment.id)
      const transportIsCurrent = (): boolean =>
        getRuntimeEnvironmentTransportGeneration(environment.id) === transportGeneration
      const sender = event.sender
      const ownerWebContentsId = sender.id
      let senderDestroyed = sender.isDestroyed()
      let subscription: RemoteRuntimeSubscription | null = null
      let lifecycleListenersAttached = false
      // Why: a renderer reload REUSES the WebContents (id unchanged), so 'destroyed' never
      // fires and the remote RPC stream would stay open forever, leaking one per reload;
      // mirror pty.ts and also close on render-process-gone + a main-frame reload.
      const onSenderReloadOrGone = (): void => closeSubscription()
      const onSenderDidStartLoading = (): void => {
        // did-start-loading also fires for in-page subframe loads; only a main-frame load is a reload.
        if (sender.isLoadingMainFrame()) {
          closeSubscription()
        }
      }
      const removeLifecycleListeners = (): void => {
        if (!lifecycleListenersAttached) {
          return
        }
        lifecycleListenersAttached = false
        sender.removeListener('destroyed', closeSubscription)
        sender.removeListener('render-process-gone', onSenderReloadOrGone)
        sender.removeListener('did-start-loading', onSenderDidStartLoading)
      }
      const closeSubscription = (): void => {
        senderDestroyed = true
        const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
        remoteRuntimeSubscriptions.delete(subscriptionId)
        if (retained) {
          retained.close()
          return
        }
        removeLifecycleListeners()
        subscription?.close()
      }
      sender.once('destroyed', closeSubscription)
      sender.on('render-process-gone', onSenderReloadOrGone)
      sender.on('did-start-loading', onSenderDidStartLoading)
      lifecycleListenersAttached = true
      try {
        subscription = await subscribeRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          {
            onEvent: (payload) => {
              if (transportIsCurrent() && !sender.isDestroyed()) {
                sender.send('runtimeEnvironments:subscriptionEvent', {
                  subscriptionId,
                  ...payload
                })
              }
            },
            onClose: () => {
              const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
              retained?.removeLifecycleListeners()
              remoteRuntimeSubscriptions.delete(subscriptionId)
            }
          }
        )
      } catch (error) {
        removeLifecycleListeners()
        throw error
      }
      let pairingIsCurrent = false
      try {
        const currentEnvironment = resolveEnvironment(getUserDataPath(), environment.id)
        pairingIsCurrent =
          (currentEnvironment.pairingRevision ?? currentEnvironment.createdAt) === pairingRevision
      } catch {
        pairingIsCurrent = false
      }
      if (!transportIsCurrent() || !pairingIsCurrent) {
        removeLifecycleListeners()
        subscription.close()
        throw new Error('Runtime environment pairing changed; refresh and try again')
      }
      if (senderDestroyed || sender.isDestroyed()) {
        removeLifecycleListeners()
        subscription.close()
        return { subscriptionId, requestId: subscription.requestId }
      }
      remoteRuntimeSubscriptions.set(subscriptionId, {
        requestId: subscription.requestId,
        environmentId: environment.id,
        ownerWebContentsId,
        removeLifecycleListeners,
        sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
        close: () => {
          removeLifecycleListeners()
          subscription?.close()
        }
      })
      return { subscriptionId, requestId: subscription.requestId }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:unsubscribe',
    (event, args: { subscriptionId: string }): { unsubscribed: boolean } => {
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (!subscription || subscription.ownerWebContentsId !== event.sender.id) {
        return { unsubscribed: false }
      }
      remoteRuntimeSubscriptions.delete(args.subscriptionId)
      subscription.close()
      return { unsubscribed: true }
    }
  )
  ipcMain.on(
    'runtimeEnvironments:subscriptionBinary',
    (event, args: { subscriptionId?: unknown; bytes?: unknown }) => {
      if (typeof args.subscriptionId !== 'string') {
        return
      }
      const bytes = toBinaryPayload(args.bytes)
      if (!bytes) {
        return
      }
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (subscription?.ownerWebContentsId === event.sender.id) {
        subscription.sendBinary(bytes)
      }
    }
  )
}

function toBinaryPayload(value: unknown): Uint8Array<ArrayBufferLike> | null {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}
