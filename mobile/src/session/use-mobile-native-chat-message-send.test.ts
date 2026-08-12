import { createElement, type MutableRefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'

const sendWithOutcome = vi.fn<[], Promise<MobileNativeChatSendOutcome>>()

vi.mock('./mobile-native-chat-send', () => ({
  openMobileNativeChatSendBudget: () => 1_000,
  sendMobileNativeChatMessageWithOutcome: () => sendWithOutcome()
}))

vi.mock('./mobile-native-chat-stale-input', () => ({
  healMobileNativeChatStaleInput: () => Promise.resolve(true)
}))

type Api = ReturnType<typeof useMobileNativeChatMessageSend>

describe('useMobileNativeChatMessageSend send classification gate', () => {
  let renderer: ReactTestRenderer | null = null
  let api: Api | null = null
  const agentRef: MutableRefObject<string | null> = { current: 'claude' }
  const acceptSend = vi.fn()
  const holdUnconfirmedSend = vi.fn()
  const restoreRejectedDraft = vi.fn()

  function origin(text: string): MobileNativeChatSendOrigin {
    return {
      draftKey: 'host\0worktree\0tab',
      pendingKey: 'host\0worktree\0tab\0session',
      normalizedText: text.trim(),
      baselineTailMessageId: null
    }
  }

  function Harness(): null {
    api = useMobileNativeChatMessageSend({
      client: {} as unknown as RpcClient,
      enabled: true,
      handleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      agentRef,
      captureSendOrigin: (text) => origin(text),
      clearDraftForSend: vi.fn(),
      restoreRejectedDraft,
      acceptSend,
      holdUnconfirmedSend,
      onSendError: vi.fn()
    })
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sendWithOutcome.mockReset()
    acceptSend.mockReset()
    holdUnconfirmedSend.mockReset()
    restoreRejectedDraft.mockReset()
    agentRef.current = 'claude'
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    api = null
  })

  async function mount(): Promise<void> {
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
    } finally {
      spy.mockRestore()
    }
  }

  it('echoes an accepted chat send optimistically', async () => {
    sendWithOutcome.mockResolvedValue('accepted')
    await mount()
    let accepted = false
    await act(async () => {
      accepted = await api!.send('hello there')
    })
    expect(accepted).toBe(true)
    expect(acceptSend).toHaveBeenCalledTimes(1)
    expect(holdUnconfirmedSend).not.toHaveBeenCalled()
  })

  it('never echoes an accepted slash-command send (no stranded "Queued" bubble)', async () => {
    sendWithOutcome.mockResolvedValue('accepted')
    await mount()
    let accepted = false
    await act(async () => {
      accepted = await api!.send('/clear')
    })
    // The command dispatched to the TUI — it will never echo as a user turn.
    expect(accepted).toBe(true)
    expect(acceptSend).not.toHaveBeenCalled()
  })

  it('arms the ack-lost hold only for chat sends', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    await mount()
    await act(async () => {
      await api!.send('hello there')
    })
    expect(holdUnconfirmedSend).toHaveBeenCalledTimes(1)
  })

  it('does not arm the ack-lost hold for an ack-lost command send', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    await mount()
    let outcome = false
    await act(async () => {
      outcome = await api!.send('/clear')
    })
    // 'unknown' is not 'rejected', so the boolean surface still reads true.
    expect(outcome).toBe(true)
    expect(holdUnconfirmedSend).not.toHaveBeenCalled()
    expect(acceptSend).not.toHaveBeenCalled()
  })
})
