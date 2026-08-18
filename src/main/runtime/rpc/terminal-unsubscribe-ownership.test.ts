import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import {
  createSubscriptionRegistryDouble,
  type SubscriptionRegistryDouble
} from './subscription-registry-test-double'

// Why: STA-4510 — terminal.unsubscribe names a stable `${terminal}:${clientId}` id that a
// reconnect rebinds to a newer connection. A stale unsubscribe from the dead socket must be
// refused, not honored. These exercise the REGISTERED handler through the real dispatcher on
// the exact production path mobile uses (dispatchStreaming carries connectionId), so the
// ownership guard is proven reachable, not just unit-tested in isolation.

function runtimeWith(registry: SubscriptionRegistryDouble): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    // The caller-scope bound is proven elsewhere; a no-op keeps these focused on ownership.
    assertTerminalHandleInCallerScope: () => {},
    registerSubscriptionCleanup: registry.registerSubscriptionCleanup,
    registerOwnedSubscriptionCleanup: registry.registerOwnedSubscriptionCleanup,
    cleanupSubscription: registry.cleanupSubscription,
    cleanupSubscriptionIfOwnedByConnection: registry.cleanupSubscriptionIfOwnedByConnection,
    cleanupSubscriptionsForConnection: registry.cleanupSubscriptionsForConnection
  } as unknown as OrcaRuntimeService
}

async function dispatchUnsubscribe(
  registry: SubscriptionRegistryDouble,
  params: { subscriptionId: string; client?: { id: string } },
  connectionId: string | undefined
): Promise<{ unsubscribed: boolean }> {
  const dispatcher = new RpcDispatcher({ runtime: runtimeWith(registry), methods: TERMINAL_METHODS })
  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.unsubscribe',
    params
  }
  const messages: string[] = []
  await dispatcher.dispatchStreaming(request, (message) => messages.push(message), { connectionId })
  return JSON.parse(messages.at(-1)!).result as { unsubscribed: boolean }
}

describe('terminal.unsubscribe ownership', () => {
  it('refuses a stale connection and keeps the rebound stream alive', async () => {
    const registry = createSubscriptionRegistryDouble()
    const cleanup = vi.fn()
    // The replacement connection now owns the stable id after a reconnect.
    registry.registerSubscriptionCleanup('term_1:phone_1', cleanup, 'conn-new')

    // A late unsubscribe from the dead socket must not tear down the replacement.
    const refused = await dispatchUnsubscribe(
      registry,
      { subscriptionId: 'term_1:phone_1' },
      'conn-old'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refused).toEqual({ unsubscribed: false })
    expect(cleanup).not.toHaveBeenCalled()
    expect(registry.peekCleanup('term_1:phone_1')).toBe(cleanup)

    // The owning connection can still retire its own subscription.
    const owned = await dispatchUnsubscribe(
      registry,
      { subscriptionId: 'term_1:phone_1' },
      'conn-new'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(owned).toEqual({ unsubscribed: true })
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('honors a connection-less caller (the local unix-socket authority tier)', async () => {
    const registry = createSubscriptionRegistryDouble()
    const cleanup = vi.fn()
    registry.registerSubscriptionCleanup('term_1:phone_1', cleanup, 'conn-owner')

    const result = await dispatchUnsubscribe(registry, { subscriptionId: 'term_1:phone_1' }, undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result).toEqual({ unsubscribed: true })
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('reports an unregistered id as gone, not refused', async () => {
    const registry = createSubscriptionRegistryDouble()
    // Why: a client retrying on `false` would otherwise chase a dead id forever.
    const result = await dispatchUnsubscribe(registry, { subscriptionId: 'term_gone' }, 'conn-a')
    expect(result).toEqual({ unsubscribed: true })
  })

  it('ANDs the bare and composite results so a real refusal is not masked by a teardown', async () => {
    const registry = createSubscriptionRegistryDouble()
    const bareCleanup = vi.fn()
    const compositeCleanup = vi.fn()
    // A clientless legacy-JSON stream registers under the bare id; a client-scoped one under
    // the composite. conn-a owns the bare id (real teardown) but not the composite (refusal).
    registry.registerSubscriptionCleanup('term_1', bareCleanup, 'conn-a')
    registry.registerSubscriptionCleanup('term_1:phone_1', compositeCleanup, 'conn-b')

    const result = await dispatchUnsubscribe(
      registry,
      { subscriptionId: 'term_1', client: { id: 'phone_1' } },
      'conn-a'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A destructive success on the bare id must not mask the composite refusal.
    expect(result).toEqual({ unsubscribed: false })
    expect(bareCleanup).toHaveBeenCalledTimes(1)
    expect(compositeCleanup).not.toHaveBeenCalled()
    expect(registry.peekCleanup('term_1:phone_1')).toBe(compositeCleanup)
  })
})
