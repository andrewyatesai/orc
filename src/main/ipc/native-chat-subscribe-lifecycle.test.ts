import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'

const { handlers, listeners, subscribeTranscript } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  subscribeTranscript: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      listeners.set(channel, handler)
    })
  }
}))

vi.mock('../native-chat/transcript-watch', () => ({
  subscribeNativeChatTranscript: subscribeTranscript
}))

import {
  _getNativeChatPendingSubscriptionCountForTest,
  _getNativeChatSenderCleanupCountForTest,
  clearNativeChatSubscriptions,
  registerNativeChatHandlers
} from './native-chat'

type TestSubscription = {
  unsubscribe: ReturnType<typeof vi.fn>
  watching: boolean
}

type DeferredSubscription = {
  promise: Promise<TestSubscription>
  reject: (error: Error) => void
  resolve: () => void
  unsubscribe: ReturnType<typeof vi.fn>
}

type SenderHarness = {
  destroy: () => void
  /** Fire a main-frame (or subframe) load, modelling a renderer reload keeping the WebContents. */
  emitReload: (kind?: 'main-frame' | 'subframe') => void
  /** Fire render-process-gone (crash), modelling a reused-but-reloaded WebContents. */
  emitProcessGone: () => void
  registeredCleanupCount: () => number
  sender: {
    id: number
    isDestroyed: () => boolean
    isLoadingMainFrame: () => boolean
    on: (event: string, callback: () => void) => void
    once: (event: string, callback: () => void) => void
    removeListener: (event: string, callback: () => void) => void
    send: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  clearNativeChatSubscriptions()
  handlers.clear()
  listeners.clear()
  subscribeTranscript.mockReset()
  registerNativeChatHandlers()
})

function deferredSubscription(): DeferredSubscription {
  const unsubscribe = vi.fn()
  let resolvePromise: (subscription: TestSubscription) => void = () => {}
  let rejectPromise: (error: Error) => void = () => {}
  const promise = new Promise<TestSubscription>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    reject: rejectPromise,
    resolve: () => resolvePromise({ unsubscribe, watching: true }),
    unsubscribe
  }
}

function createSender(id: number): SenderHarness {
  let destroyed = false
  let loadingMainFrame = true
  const listeners = new Map<string, Set<() => void>>()
  const add = (event: string, callback: () => void): void => {
    const set = listeners.get(event) ?? new Set<() => void>()
    set.add(callback)
    listeners.set(event, set)
  }
  const fire = (event: string): void => {
    // Snapshot into an array so a callback that removes its own listener mid-fire can't
    // perturb iteration (a real WebContents emit already sees a stable listener list).
    const callbacks = Array.from(listeners.get(event) ?? [])
    for (const callback of callbacks) {
      callback()
    }
  }
  return {
    destroy: () => {
      destroyed = true
      fire('destroyed')
    },
    emitReload: (kind = 'main-frame') => {
      loadingMainFrame = kind === 'main-frame'
      fire('did-start-loading')
    },
    emitProcessGone: () => fire('render-process-gone'),
    // Only 'destroyed' registrations count as strict-cleanup registrations for the legacy assertions.
    registeredCleanupCount: () => listeners.get('destroyed')?.size ?? 0,
    sender: {
      id,
      isDestroyed: () => destroyed,
      isLoadingMainFrame: () => loadingMainFrame,
      on: add,
      once: (event, callback) => {
        // once self-removes after firing so a reused sender doesn't double-fire 'destroyed'.
        const wrapped = (): void => {
          listeners.get(event)?.delete(wrapped)
          callback()
        }
        add(event, wrapped)
      },
      removeListener: (event, callback) => {
        listeners.get(event)?.delete(callback)
      },
      send: vi.fn()
    }
  }
}

function subscribe(sender: SenderHarness['sender'], subscriptionId: string): void {
  const listener = listeners.get('nativeChat:subscribe')
  if (!listener) {
    throw new Error('subscribe listener not registered')
  }
  listener({ sender }, { subscriptionId, agent: 'claude', sessionId: `session-${subscriptionId}` })
}

type InitialSnapshotCallback = (
  messages: unknown[],
  hasMore: boolean,
  beforeOffset: number,
  error?: string,
  lifecycle?: NativeChatTurnLifecycle
) => void

// The onInitialSnapshot callback the handler passed into the Nth subscribeTranscript
// call; transcript-watch fires it during setup, so tests invoke it directly.
function initialSnapshot(callIndex: number): InitialSnapshotCallback {
  const call = subscribeTranscript.mock.calls[callIndex]
  if (!call) {
    throw new Error('subscribeTranscript was not called')
  }
  return (call[0] as { onInitialSnapshot: InitialSnapshotCallback }).onInitialSnapshot
}

function unsubscribe(sender: SenderHarness['sender'], subscriptionId: string): void {
  const listener = listeners.get('nativeChat:unsubscribe')
  if (!listener) {
    throw new Error('unsubscribe listener not registered')
  }
  listener({ sender }, { subscriptionId })
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for lifecycle state')
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('nativeChat subscribe lifecycle', () => {
  it('closes a watcher that resolves after renderer unsubscribe', async () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(1)

    subscribe(renderer.sender, 'unmount')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(1)
    unsubscribe(renderer.sender, 'unmount')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)
    unsubscribe(renderer.sender, 'unmount')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)

    pending.resolve()
    await waitFor(() => pending.unsubscribe.mock.calls.length === 1)
    unsubscribe(renderer.sender, 'unmount')
    expect(pending.unsubscribe).toHaveBeenCalledOnce()
    renderer.destroy()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('closes a watcher that resolves after renderer destruction', async () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(2)

    subscribe(renderer.sender, 'destroy')
    renderer.destroy()
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(0)
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)

    pending.resolve()
    await waitFor(() => pending.unsubscribe.mock.calls.length === 1)
  })

  it('keeps the latest same-id subscribe when setup resolves in reverse order', async () => {
    const older = deferredSubscription()
    const newer = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const renderer = createSender(3)

    subscribe(renderer.sender, 'same-id')
    subscribe(renderer.sender, 'same-id')
    expect(_getNativeChatPendingSubscriptionCountForTest()).toBe(1)

    newer.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    expect(newer.unsubscribe).not.toHaveBeenCalled()
    older.resolve()
    await waitFor(() => older.unsubscribe.mock.calls.length === 1)

    unsubscribe(renderer.sender, 'same-id')
    expect(newer.unsubscribe).toHaveBeenCalledOnce()
    renderer.destroy()
  })

  it('clears rejected setup without duplicating sender cleanup registration', async () => {
    const failed = deferredSubscription()
    const retry = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise)
    const renderer = createSender(4)

    subscribe(renderer.sender, 'retry')
    failed.reject(new Error('watch setup failed'))
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(1)

    subscribe(renderer.sender, 'retry')
    expect(renderer.registeredCleanupCount()).toBe(1)
    retry.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    unsubscribe(renderer.sender, 'retry')
    expect(retry.unsubscribe).toHaveBeenCalledOnce()
    renderer.destroy()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('isolates late setup from a replacement renderer reusing the sender id', async () => {
    const oldPending = deferredSubscription()
    const replacementPending = deferredSubscription()
    subscribeTranscript
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(replacementPending.promise)
    const oldRenderer = createSender(41)
    const replacementRenderer = createSender(41)

    subscribe(oldRenderer.sender, 'remount')
    oldRenderer.destroy()
    subscribe(replacementRenderer.sender, 'remount')
    expect(replacementRenderer.registeredCleanupCount()).toBe(1)

    replacementPending.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    oldPending.resolve()
    await waitFor(() => oldPending.unsubscribe.mock.calls.length === 1)
    expect(replacementPending.unsubscribe).not.toHaveBeenCalled()

    replacementRenderer.destroy()
    expect(replacementPending.unsubscribe).toHaveBeenCalledOnce()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('forwards an initial-drain error onto the snapshot frame', () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(5)

    subscribe(renderer.sender, 'drain-error')
    // transcript-watch delivers the drain error synchronously via onInitialSnapshot;
    // invoke the captured callback to exercise the handler's forwarding closure.
    initialSnapshot(0)([], false, 0, 'Transcript unavailable')

    expect(renderer.sender.send).toHaveBeenCalledWith('nativeChat:appended', {
      subscriptionId: 'drain-error',
      frame: {
        type: 'snapshot',
        messages: [],
        hasMore: false,
        error: 'Transcript unavailable'
      }
    })
  })

  it('omits error from the snapshot frame on a clean initial drain', () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(6)

    subscribe(renderer.sender, 'drain-clean')
    initialSnapshot(0)([], false, 0)

    expect(renderer.sender.send).toHaveBeenCalledWith('nativeChat:appended', {
      subscriptionId: 'drain-clean',
      frame: {
        type: 'snapshot',
        messages: [],
        hasMore: false
      }
    })
  })

  it('tears down live watchers on a main-frame renderer reload (WebContents reused)', async () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(70)

    subscribe(renderer.sender, 'reload')
    pending.resolve()
    // Wait until the watcher is published into the live map (pending drains to 0).
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    expect(pending.unsubscribe).not.toHaveBeenCalled()

    // A reload reuses the WebContents, so 'destroyed' never fires — the reload event must
    // release the orphaned transcript watcher instead.
    renderer.emitReload('main-frame')
    expect(pending.unsubscribe).toHaveBeenCalledOnce()
    // Disposer stays armed (sender still alive) so the NEXT reload also tears down.
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(1)
    expect(renderer.sender.isDestroyed()).toBe(false)

    renderer.destroy()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('tears down live watchers on render-process-gone (renderer crash)', async () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(71)

    subscribe(renderer.sender, 'crash')
    pending.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)

    renderer.emitProcessGone()
    expect(pending.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does NOT tear down watchers on an in-page subframe load', async () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(72)

    subscribe(renderer.sender, 'subframe')
    pending.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)

    // isLoadingMainFrame() === false: a srcDoc iframe load must not drop the alive page's watcher.
    renderer.emitReload('subframe')
    expect(pending.unsubscribe).not.toHaveBeenCalled()

    renderer.destroy()
    expect(pending.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not re-arm (duplicate) lifecycle listeners across a reload+resubscribe', async () => {
    const first = deferredSubscription()
    const second = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const renderer = createSender(73)

    subscribe(renderer.sender, 'first')
    first.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)
    renderer.emitReload('main-frame')
    expect(first.unsubscribe).toHaveBeenCalledOnce()

    // The reloaded page re-subscribes under a fresh id; the disposer must still be a single
    // registration (no listener accumulation across reloads).
    subscribe(renderer.sender, 'second')
    expect(renderer.registeredCleanupCount()).toBe(1)
    second.resolve()
    await waitFor(() => _getNativeChatPendingSubscriptionCountForTest() === 0)

    renderer.destroy()
    expect(second.unsubscribe).toHaveBeenCalledOnce()
    expect(_getNativeChatSenderCleanupCountForTest()).toBe(0)
  })

  it('forwards replayable lifecycle on the initial snapshot', () => {
    const pending = deferredSubscription()
    subscribeTranscript.mockReturnValueOnce(pending.promise)
    const renderer = createSender(7)
    const lifecycle = { state: 'completed', turnId: 'turn-1', timestamp: 42 } as const

    subscribe(renderer.sender, 'lifecycle')
    initialSnapshot(0)([], false, 0, undefined, lifecycle)

    expect(renderer.sender.send).toHaveBeenCalledWith('nativeChat:appended', {
      subscriptionId: 'lifecycle',
      frame: {
        type: 'snapshot',
        messages: [],
        hasMore: false,
        lifecycle
      }
    })
  })
})
