import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('useMobileNativeChatSession', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSession | null = null
  let emit: (frame: unknown) => void = () => {}

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({
    client,
    sourceIdentity = 'host\0worktree'
  }: {
    client: RpcClient | null
    sourceIdentity?: string
  }): null {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity,
      agent: 'claude',
      sessionId: 'session',
      transcriptPath: null
    })
    return null
  }

  async function mount(client: RpcClient): Promise<void> {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { client }))
      })
    } finally {
      consoleSpy.mockRestore()
    }
  }

  it('drops an older-page response captured before transcript replacement', async () => {
    let resolveEarlier: (response: unknown) => void = () => {}
    const sendRequest = vi.fn(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    ) as unknown as RpcClient['sendRequest']
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`old-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    act(() => state?.loadEarlier())

    await act(async () => {
      emit({
        type: 'replacement',
        messages: [message('replacement')],
        hasMore: false,
        beforeOffset: 0
      })
    })
    await act(async () => {
      resolveEarlier({
        ok: true,
        result: { messages: [message('stale-page')], hasMore: false, beforeOffset: 0 }
      })
      await Promise.resolve()
    })

    expect(state?.messages.map((entry) => entry.id)).toEqual(['replacement'])
    expect(state?.loadingEarlier).toBe(false)
  })

  it('drops an older-page response after the client source disappears', async () => {
    let resolveEarlier: (response: unknown) => void = () => {}
    const sendRequest = vi.fn(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    ) as unknown as RpcClient['sendRequest']
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`old-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    act(() => state?.loadEarlier())
    await act(async () => renderer?.update(createElement(Harness, { client: null })))
    await act(async () => {
      resolveEarlier({ ok: true, result: { messages: [message('stale-page')] } })
      await Promise.resolve()
    })

    expect(state?.messages).toEqual([])
    expect(state?.status).toBe('idle')
    expect(state?.loadingEarlier).toBe(false)
  })

  it.each(['replacement', 'snapshot'] as const)(
    'can page again after an authoritative %s resets a maxed-out read window',
    async (frameType) => {
      const sendRequest = vi.fn().mockResolvedValue({
        ok: true,
        result: { messages: [message('older')], hasMore: true, beforeOffset: 50 }
      })
      const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
        emit = onData
        onData({
          type: 'snapshot',
          messages: Array.from({ length: 40 }, (_unused, index) => message(`old-${index}`)),
          hasMore: true,
          beforeOffset: 100
        })
        return () => {}
      })
      await mount({ sendRequest, subscribe } as unknown as RpcClient)
      for (let page = 0; page < 33; page += 1) {
        await act(async () => {
          state?.loadEarlier()
          await Promise.resolve()
        })
      }
      const requestsAtCap = sendRequest.mock.calls.length

      await act(async () =>
        emit({
          type: frameType,
          messages: [message('authoritative')],
          hasMore: true,
          beforeOffset: 500
        })
      )
      await act(async () => {
        state?.loadEarlier()
        await Promise.resolve()
      })

      expect(sendRequest).toHaveBeenCalledTimes(requestsAtCap + 1)
      expect(sendRequest).toHaveBeenLastCalledWith('nativeChat.readSession', {
        agent: 'claude',
        sessionId: 'session',
        limit: 60,
        beforeOffset: 500
      })
    }
  )

  it('keeps paged-in history across an auto-reconnect replay snapshot', async () => {
    // The transport replays the subscription with its original params after an
    // in-place reconnect, so the replayed snapshot is the newest initial window
    // again. It must merge into the grown history, not truncate it back to 40.
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        messages: Array.from({ length: 60 }, (_unused, index) => message(`paged-${index}`)),
        hasMore: false,
        beforeOffset: 40
      }
    })
    const window = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    await act(async () => {
      state?.loadEarlier()
      await Promise.resolve()
    })
    expect(state?.messages).toHaveLength(100)

    // Reconnect replay: the same newest-40 window. History survives untouched.
    await act(async () =>
      emit({ type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 })
    )
    expect(state?.messages).toHaveLength(100)
    expect(state?.messages[0]?.id).toBe('paged-0')

    // A replay carrying one message that arrived while away merges it in; the
    // grown window stays bounded, so only the single oldest row trims.
    await act(async () =>
      emit({
        type: 'snapshot',
        messages: [...window, message('live-1')],
        hasMore: true,
        beforeOffset: 100
      })
    )
    expect(state?.messages).toHaveLength(100)
    expect(state?.messages[0]?.id).toBe('paged-1')
    expect(state?.messages.at(-1)?.id).toBe('live-1')
  })

  it('enables paging when a replay trims a window that previously had no earlier rows', async () => {
    // Never settles: this asserts the request the replay's cursor produces.
    const sendRequest = vi.fn(() => new Promise<never>(() => {}))
    const window = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: window, hasMore: false, beforeOffset: 0 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)

    await act(async () =>
      emit({
        type: 'snapshot',
        messages: [...window.slice(1), message('live-1')],
        hasMore: true,
        beforeOffset: 10
      })
    )

    expect(state?.messages[0]?.id).toBe('win-1')
    expect(state?.hasMore).toBe(true)
    act(() => state?.loadEarlier())
    expect(sendRequest).toHaveBeenCalledWith('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      limit: 100
    })
  })

  it('drops paged rows that an authoritative replay says were removed', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        messages: Array.from({ length: 60 }, (_unused, index) => message(`paged-${index}`)),
        hasMore: false,
        beforeOffset: 40
      }
    })
    const window = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: window, hasMore: true, beforeOffset: 100 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    await act(async () => {
      state?.loadEarlier()
      await Promise.resolve()
    })
    expect(state?.messages).toHaveLength(100)

    await act(async () =>
      emit({ type: 'snapshot', messages: window, hasMore: false, beforeOffset: 0 })
    )

    expect(state?.messages).toEqual(window)
    expect(state?.hasMore).toBe(false)
  })

  it('clears a stale cursor when a replacement omits paging metadata', async () => {
    // Never settles: this asserts the request the cleared cursor produces.
    const sendRequest = vi.fn(() => new Promise<never>(() => {}))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)

    await act(async () =>
      emit({
        type: 'replacement',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`new-${index}`))
      })
    )
    act(() => state?.loadEarlier())

    expect(sendRequest).toHaveBeenCalledWith('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      limit: 100
    })
  })

  it('clears hasMore when a replaced window is shorter than the initial page', async () => {
    // A replaced window without paging metadata is judged by its own length:
    // shorter than a full page means the whole transcript is on screen.
    const sendRequest = vi.fn()
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    expect(state?.hasMore).toBe(true)

    await act(async () => emit({ type: 'replacement', messages: [message('only')] }))

    expect(state?.hasMore).toBe(false)
  })

  it('fences an in-flight older page when a merging replay re-cuts the byte cursor', async () => {
    let resolveEarlier: (response: unknown) => void = () => {}
    const sendRequest = vi.fn(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    ) as unknown as RpcClient['sendRequest']
    const retained = Array.from({ length: 40 }, (_unused, index) => message(`win-${index}`))
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: retained, hasMore: true, beforeOffset: 100 })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    act(() => state?.loadEarlier())

    // The replay merges (same rows, no trim), but the host re-cut the file, so
    // it carries a new cursor. The page already in flight was addressed with the
    // old offset and would write that stale cursor back over the fresh one.
    await act(async () =>
      emit({ type: 'snapshot', messages: retained, hasMore: true, beforeOffset: 250 })
    )
    await act(async () => {
      resolveEarlier({
        ok: true,
        result: { messages: [message('stale-page')], hasMore: true, beforeOffset: 40 }
      })
      await Promise.resolve()
    })

    expect(state?.messages.some((entry) => entry.id === 'stale-page')).toBe(false)
    expect(state?.loadingEarlier).toBe(false)
  })

  it('keeps the base snapshot authoritative when a live append arrives first', async () => {
    const sendRequest = vi.fn()
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    // Only a snapshot marks the base as delivered, so an append landing first
    // must not demote the real base snapshot to a reconnect replay.
    await act(async () =>
      emit({ type: 'appended', messages: [message('early-a'), message('early-b')] })
    )
    await act(async () =>
      emit({
        type: 'snapshot',
        messages: [message('early-b'), message('base-c')],
        hasMore: true,
        beforeOffset: 3
      })
    )

    expect(state?.messages.map((entry) => entry.id)).toEqual(['early-b', 'base-c'])
  })

  it('rejects a cursor page invalidated by live trim and retries with a growing tail', async () => {
    let resolveCursorPage: (response: unknown) => void = () => {}
    const sendRequest = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveCursorPage = resolve)))
      .mockResolvedValueOnce({
        ok: true,
        result: { messages: [message('fresh-growing-tail')], hasMore: false }
      })
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({
        type: 'snapshot',
        messages: Array.from({ length: 40 }, (_unused, index) => message(`window-${index}`)),
        hasMore: true,
        beforeOffset: 100
      })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    act(() => state?.loadEarlier())
    await act(async () => emit({ type: 'appended', messages: [message('live-trim')] }))
    await act(async () => {
      resolveCursorPage({
        ok: true,
        result: { messages: [message('stale-cursor-page')], hasMore: true, beforeOffset: 50 }
      })
      await Promise.resolve()
    })
    expect(state?.messages.map((entry) => entry.id)).not.toContain('stale-cursor-page')

    await act(async () => {
      state?.loadEarlier()
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenLastCalledWith('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      limit: 100
    })
    expect(state?.messages.map((entry) => entry.id)).toEqual(['fresh-growing-tail'])
  })

  it('keeps the transcript on screen across a same-source client reconnect', async () => {
    // A manual retry swaps the client under an unchanged identity. The effect
    // re-runs and clears the list to loading, but the retained transcript must
    // stay visible until the fresh subscription replays its snapshot.
    const sendRequest = vi.fn() as unknown as RpcClient['sendRequest']
    const makeSubscribe = (autoSnapshot: boolean): RpcClient['subscribe'] =>
      vi.fn((_method, _params, onData) => {
        emit = onData
        if (autoSnapshot) {
          onData({ type: 'snapshot', messages: [message('a'), message('b')], hasMore: false })
        }
        return () => {}
      })
    await mount({ sendRequest, subscribe: makeSubscribe(true) } as unknown as RpcClient)
    expect(state?.messages.map((entry) => entry.id)).toEqual(['a', 'b'])

    // Fresh client, same identity, whose subscription has not replayed yet.
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          client: { sendRequest, subscribe: makeSubscribe(false) } as unknown as RpcClient
        })
      )
    )
    expect(state?.status).toBe('loading')
    expect(state?.transcriptLoading).toBe(true)
    expect(state?.messages.map((entry) => entry.id)).toEqual(['a', 'b'])

    // The swapped client's snapshot lands and takes over the visible list.
    await act(async () =>
      emit({ type: 'snapshot', messages: [message('a'), message('b'), message('c')], hasMore: false })
    )
    expect(state?.messages.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not retain a prior source when the identity changes underneath a reconnect', async () => {
    // Same hook instance, but the source identity also changed: the retained list
    // belongs to the old source and must not bleed into the new one's loading view.
    const sendRequest = vi.fn() as unknown as RpcClient['sendRequest']
    const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
      emit = onData
      onData({ type: 'snapshot', messages: [message('a'), message('b')], hasMore: false })
      return () => {}
    })
    await mount({ sendRequest, subscribe } as unknown as RpcClient)
    expect(state?.messages.map((entry) => entry.id)).toEqual(['a', 'b'])

    // A fresh client under a NEW source whose subscription has not replayed yet.
    const quietClient = {
      sendRequest,
      subscribe: vi.fn((_method, _params, onData) => {
        emit = onData
        return () => {}
      })
    } as unknown as RpcClient
    await act(async () =>
      renderer?.update(
        createElement(Harness, { client: quietClient, sourceIdentity: 'other-host\0worktree' })
      )
    )

    expect(state?.status).toBe('loading')
    expect(state?.messages).toEqual([])
  })
})
