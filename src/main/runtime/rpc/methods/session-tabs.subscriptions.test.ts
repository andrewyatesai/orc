import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab subscription RPC methods', () => {
  it('streams all known session tab snapshots and later updates', async () => {
    const unsubscribe = vi.fn()
    const listeners: ((snapshot: unknown) => void)[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAllMobileSessionTabs: vi.fn(() => [
        {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        {
          worktree: 'wt-2',
          publicationEpoch: 'epoch-2',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]),
      onMobileSessionTabsChanged: vi.fn((listener: (snapshot: unknown) => void) => {
        listeners.push(listener)
        return unsubscribe
      }),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )
    listeners[0]?.({
      worktree: 'wt-1',
      publicationEpoch: 'epoch-3',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*:req-1',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.onMobileSessionTabsChanged).toHaveBeenCalledTimes(1)
    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      {
        type: 'snapshots',
        snapshots: [
          expect.objectContaining({ worktree: 'wt-1' }),
          expect.objectContaining({ worktree: 'wt-2' })
        ]
      },
      expect.objectContaining({ type: 'updated', worktree: 'wt-1', snapshotVersion: 2 })
    ])
  })

  it('keeps duplicate all-session-tab subscribers independent on one connection', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAllMobileSessionTabs: vi.fn(() => []),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribeAll'), id: 'sub-all-1' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )
    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribeAll'), id: 'sub-all-2' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*:sub-all-1',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*:sub-all-2',
      expect.any(Function),
      'conn-1'
    )
  })

  it('registers session tab subscription cleanup on the raw selector before the resolve await', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribe', { worktree: 'id:wt-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    // Why: the teardown must register before the async initial list resolves, so
    // the key uses the pre-await raw selector, not the post-await resolved id.
    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:id:wt-1:req-1',
      expect.any(Function),
      'conn-1'
    )
  })

  it('keeps duplicate session tab subscribers for one worktree independent', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribe', { worktree: 'id:wt-1' }), id: 'sub-1' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )
    await dispatcher.dispatchStreaming(
      { ...makeRequest('session.tabs.subscribe', { worktree: 'wt-1' }), id: 'sub-2' },
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:id:wt-1:sub-1',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:wt-1:sub-2',
      expect.any(Function),
      'conn-1'
    )
  })

  it('does not leak the tab-change listener when the socket closes during the initial list', async () => {
    const registered = new Map<string, () => void | Promise<void>>()
    const byConnection = new Map<string, Set<string>>()
    let resolveList: (value: unknown) => void = () => {}
    const listDeferred = new Promise<unknown>((resolve) => {
      resolveList = resolve
    })
    const changeListeners: ((snapshot: unknown) => void)[] = []
    const unsubscribe = vi.fn()
    // Why: mimic the real registry — cleanupSubscriptionsForConnection only tears
    // down ids registered at call time, so a subscribe still awaiting the list has
    // nothing to sweep and would leak its post-await listener without the fix.
    const cleanupSubscriptionsForConnection = (connectionId: string): void => {
      const set = byConnection.get(connectionId)
      if (!set) {
        return
      }
      for (const id of Array.from(set)) {
        const cleanup = registered.get(id)
        registered.delete(id)
        set.delete(id)
        void cleanup?.()
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn(() => listDeferred),
      onMobileSessionTabsChanged: vi.fn((listener: (snapshot: unknown) => void) => {
        changeListeners.push(listener)
        return unsubscribe
      }),
      registerSubscriptionCleanup: vi.fn(
        (id: string, cleanup: () => void | Promise<void>, connectionId: string) => {
          registered.set(id, cleanup)
          let set = byConnection.get(connectionId)
          if (!set) {
            set = new Set()
            byConnection.set(connectionId, set)
          }
          set.add(id)
        }
      ),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = registered.get(id)
        registered.delete(id)
        for (const set of byConnection.values()) {
          set.delete(id)
        }
        void cleanup?.()
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const emitted: string[] = []

    const streaming = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribe', { worktree: 'id:wt-1' }),
      (message) => emitted.push(message),
      { connectionId: 'c1' }
    )

    // The socket closes while the initial list is still pending.
    await Promise.resolve()
    cleanupSubscriptionsForConnection('c1')

    // The initial list finally resolves after the close.
    resolveList({
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    await streaming

    // No live tab-change listener was installed for the dead connection.
    expect(runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
    changeListeners.forEach((listener) => listener({ worktree: 'wt-1', snapshotVersion: 2 }))
    expect(emitted.map((message) => JSON.parse(message).result?.type)).not.toContain('updated')
  })

  it('tears down the subscription registry entry when the initial list rejects', async () => {
    // Why: cleanup registers before the initial-list await; a rejected list must
    // run that cleanup before rethrowing or the entry leaks in the registry and
    // by-connection index (Codex cxr2), accumulating on a long-lived socket.
    const cleanupSubscription = vi.fn()
    const listError = new Error('missing worktree')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockRejectedValue(listError),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribe', { worktree: 'id:wt-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:id:wt-1:req-1')
    // The failed initial list must not have installed a live tab-change listener.
    expect(runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
  })

  it('unsubscribes a session tabs stream using the resolved worktree id and connection id', async () => {
    const cleanupSubscription = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      cleanupSubscription,
      cleanupSubscriptionsByPrefix: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.unsubscribe', { worktree: 'id:wt-1' }),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:wt-1')
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: true,
      result: { unsubscribed: true }
    })
  })

  it('unsubscribes one shared-control session tab stream by subscription id', async () => {
    const cleanupSubscription = vi.fn()
    const cleanupSubscriptionsByPrefix = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }),
      cleanupSubscription,
      cleanupSubscriptionsByPrefix
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.unsubscribe', { worktree: 'id:wt-1', subscriptionId: 'sub-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:wt-1:sub-1')
    expect(cleanupSubscriptionsByPrefix).not.toHaveBeenCalled()
  })

  it('unsubscribes one shared-control all-session-tabs stream by subscription id', async () => {
    const cleanupSubscription = vi.fn()
    const cleanupSubscriptionsByPrefix = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscription,
      cleanupSubscriptionsByPrefix
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.unsubscribeAll', { subscriptionId: 'sub-all-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:*:sub-all-1')
    expect(cleanupSubscriptionsByPrefix).not.toHaveBeenCalled()
  })
})
