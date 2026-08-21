import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

const acceptSend = vi.fn()
const captureSendOrigin = vi.fn()
const clearDraftForSend = vi.fn()
const restoreRejectedDraft = vi.fn()
const holdUnconfirmedSend = vi.fn()

// Mutable stand-ins so the ask-dismissal describe below can drive chat resolution
// and transcript state; the defaults keep the send-seam tests unchanged.
const viewMode = { isTabChatView: (_tabId: string) => true }
const sessionState: { messages: unknown[]; status: string; transcriptLoading: boolean } = {
  messages: [],
  status: 'ready',
  transcriptLoading: false
}
const promptsState = {
  permission: null as unknown,
  question: null as unknown,
  detectedAsk: null as unknown,
  ask: null as unknown
}

// The controller composes many session hooks; each is mocked to a minimal shape
// so this test isolates the send seam (outcome -> drafts accounting) and the
// ask-dismissal seam (transcript state -> dismissal retirement).
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    isTabChatView: (tabId: string) => viewMode.isTabChatView(tabId),
    toggleTabChatView: vi.fn()
  })
}))
vi.mock('./use-mobile-native-chat-session', () => ({
  useMobileNativeChatSession: () => sessionState
}))
vi.mock('./use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    composerText: '',
    setComposerText: vi.fn(),
    pending: [],
    imagePreviewsByMessageId: {},
    captureSendOrigin,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  })
}))
vi.mock('./use-mobile-native-chat-prompts', () => ({
  useMobileNativeChatPrompts: () => promptsState
}))
vi.mock('./use-mobile-native-chat-answer-send', () => ({
  useMobileNativeChatAnswerSend: () => ({ answerAsk: vi.fn(), cancelPending: vi.fn() })
}))
vi.mock('./mobile-native-chat-permission-send', () => ({
  useMobileNativeChatPermissionSend: () => vi.fn()
}))
vi.mock('./use-mobile-native-chat-stop', () => ({
  useMobileNativeChatStop: () => vi.fn()
}))
vi.mock('./use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))
// Partial: the stale-input heal reaches the real transport through image-send,
// which must read the REAL timeout constant, not a copy that can silently drift.
vi.mock('./mobile-native-chat-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-native-chat-send')>()),
  sendMobileNativeChatMessageWithOutcome: vi.fn()
}))

import { sendMobileNativeChatMessageWithOutcome } from './mobile-native-chat-send'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../src/shared/agent-tui-input-clear'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
import {
  useMobileNativeChatController,
  type MobileNativeChatController
} from './use-mobile-native-chat-controller'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

const sendWithOutcome = vi.mocked(sendMobileNativeChatMessageWithOutcome)

const ORIGIN = {
  draftKey: 'h\0w\0tab-1',
  pendingKey: 'h\0w\0tab-1\0session-1',
  normalizedText: 'look',
  baselineOccurrences: 0,
  baselineTailMessageId: null
}

describe('useMobileNativeChatController handleNativeChatSend', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  const onSendError = vi.fn()
  const onSendResolved = vi.fn()
  // Only the stale-input heal reaches the transport directly (the message send
  // itself is mocked above).
  const clientStub = { sendRequest: vi.fn() }

  function Harness({ connState = 'connected' }: { connState?: ConnectionState }): null {
    controller = useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState,
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: null,
      activeSessionTabId: 'tab-1',
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError,
      onSendResolved
    })
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    resetMobileNativeChatStaleInputForTests()
    captureSendOrigin.mockReturnValue(ORIGIN)
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      if (typeof a[0] === 'string' && a[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...a)
    })
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
    } finally {
      spy.mockRestore()
    }
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
  })

  it('clears an orphaned image paste before a question-card answer (#10228)', async () => {
    // The chat overlay wires the question card straight to this send, bypassing
    // the image hook that used to own the only heal.
    markMobileNativeChatInputStale('term-1')
    clientStub.sendRequest.mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'r' }
    })
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(true)
    expect(clientStub.sendRequest).toHaveBeenCalledTimes(1)
    expect(clientStub.sendRequest.mock.calls[0]?.[1]).toMatchObject({
      terminal: 'term-1',
      text: AGENT_TUI_CLEAR_INPUT_MAX,
      enter: false
    })
    expect(isMobileNativeChatInputStale('term-1')).toBe(false)
  })

  it('does not send when the healing clear is rejected, keeping the marker', async () => {
    markMobileNativeChatInputStale('term-1')
    clientStub.sendRequest.mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'r' }
    })
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(false)
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })

  it('keeps the marker when Escape cancels an ask, which never submits the composer', async () => {
    markMobileNativeChatInputStale('term-1')
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatCancelAsk()
    })
    expect(accepted).toBe(true)
    // The clear would be swallowed by the live overlay but still acked, burning
    // the marker and leaving the paste to corrupt the next real message.
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })

  it('retires a held failure banner when a card action is accepted', async () => {
    // The banner is route-owned and outlives the write that raised it, so an accepted
    // answer or permission reply must clear it too — not just a composer send.
    sendWithOutcome.mockResolvedValue('accepted')
    await act(async () => {
      await controller!.handleNativeChatCancelAsk()
    })
    expect(onSendResolved).toHaveBeenCalled()

    onSendResolved.mockClear()
    sendWithOutcome.mockResolvedValue('rejected')
    await act(async () => {
      await controller!.handleNativeChatCancelAsk()
    })
    expect(onSendResolved).not.toHaveBeenCalled()
  })

  it('threads the optimistic-echo image URIs into acceptSend on an accepted send', async () => {
    sendWithOutcome.mockResolvedValue('accepted')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(true)
    expect(acceptSend).toHaveBeenCalledWith(ORIGIN, 'look', ['file:///a.jpg'])
    // Optimistic clear happens at send time, never a restore on success.
    expect(clearDraftForSend).toHaveBeenCalledWith(ORIGIN, 'look')
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('holds an unknown-outcome send without posting the optimistic echo', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    let accepted = false
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(true)
    expect(acceptSend).not.toHaveBeenCalled()
    expect(holdUnconfirmedSend).toHaveBeenCalledWith(ORIGIN, 'look', expect.any(Function))
    // Delivery-unknown usually means delivered — keep the composer clear.
    expect(clearDraftForSend).toHaveBeenCalledWith(ORIGIN, 'look')
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
  })

  it('preserves the unknown outcome on the WithOutcome surface for paste-first callers', async () => {
    sendWithOutcome.mockResolvedValue('unknown')
    let outcome = 'accepted'
    await act(async () => {
      outcome = await controller!.handleNativeChatSendWithOutcome('look', ['file:///a.jpg'])
    })
    // Image sends heal a possibly-orphaned paste off this — 'unknown' must not
    // collapse into the boolean 'sent' shape (#10228).
    expect(outcome).toBe('unknown')
    expect(holdUnconfirmedSend).toHaveBeenCalledWith(ORIGIN, 'look', expect.any(Function))
  })

  it('fails a send fast while the socket is down, before spending the heal budget', async () => {
    // The lease collapses a render after connState, so a question-card answer could
    // otherwise sit in `sending` for the whole 15s heal+send budget.
    markMobileNativeChatInputStale('term-1')
    await act(async () => {
      renderer?.update(createElement(Harness, { connState: 'connecting' }))
    })
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('answer')
    })
    expect(accepted).toBe(false)
    expect(clientStub.sendRequest).not.toHaveBeenCalled()
    expect(sendWithOutcome).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent (disconnected)')
  })

  it('reports a rejected send and posts no echo', async () => {
    sendWithOutcome.mockResolvedValue('rejected')
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatSend('look', ['file:///a.jpg'])
    })
    expect(accepted).toBe(false)
    expect(acceptSend).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    // A definite rejection puts the optimistically-cleared text back.
    expect(restoreRejectedDraft).toHaveBeenCalledWith(ORIGIN, 'look')
  })

  it('does not restore a rejected question answer into the composer', async () => {
    sendWithOutcome.mockResolvedValue('rejected')
    let accepted = true
    await act(async () => {
      accepted = await controller!.handleNativeChatQuestionAnswer('1')
    })

    expect(accepted).toBe(false)
    expect(clearDraftForSend).not.toHaveBeenCalled()
    expect(restoreRejectedDraft).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
  })
})

describe('useMobileNativeChatController ask dismissal across a transcript reload', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  const clientStub = { sendRequest: vi.fn() }
  const PROMPT = { questions: [{ question: 'Which path?', multiSelect: false, options: [] }] }

  const chatTab = { type: 'terminal', id: 'tab-1', launchAgent: 'claude' }
  /** Mutable so a test can move the user to another tab — or restart the agent
   *  into a new provider session on the same tab — mid-render. */
  const activeTab = { id: 'tab-1', sessionId: 'session-1' }

  function Harness(): null {
    controller = useMobileNativeChatController({
      client: clientStub as unknown as RpcClient,
      connState: 'connected',
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: {
        ...chatTab,
        id: activeTab.id,
        agentStatus: { agentType: 'claude', providerSession: { id: activeTab.sessionId } }
      } as never,
      activeSessionTabId: activeTab.id,
      activeHandleRef: { current: 'term-1' },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: true,
      onSendError: vi.fn(),
      onSendResolved: vi.fn()
    })
    return null
  }

  /** Re-render under the current viewMode/prompts/session stand-ins. */
  function step(): void {
    act(() => {
      renderer?.update(createElement(Harness))
    })
  }

  /** Drive the transcript stand-in the way the real hook couples its fields, so
   *  these tests can only express states the session hook can actually reach:
   *  `transcriptLoading` is exactly `status === 'loading'`, and `messages` is
   *  withheld until a read lands. `rows` is what the last landed read left
   *  behind — 0 means no read has ever landed for this identity. */
  function setTranscript(status: MobileNativeChatStatus, rows = 1): void {
    sessionState.status = status
    sessionState.transcriptLoading = status === 'loading'
    sessionState.messages =
      status === 'ready' || status === 'error' ? Array.from({ length: rows }, () => ({})) : []
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    viewMode.isTabChatView = () => true
    setTranscript('ready')
    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      if (typeof a[0] === 'string' && a[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...a)
    })
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
    } finally {
      spy.mockRestore()
    }
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
    promptsState.ask = null
    promptsState.detectedAsk = null
    setTranscript('ready', 0)
    viewMode.isTabChatView = () => true
    activeTab.id = 'tab-1'
    activeTab.sessionId = 'session-1'
  })

  it('scopes the dismissal to the tab it was taken on', () => {
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    // Another tab's agent is parked on a byte-identical question; it is a
    // different pending prompt and tab 1's answer must not hide it.
    activeTab.id = 'tab-2'
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('shows a restarted session’s identical first question on the same tab', () => {
    // A restart, `/clear`, or resume swaps the provider session inside one tab,
    // and the next session's first question is often byte-identical — same repo,
    // same prompt, same template. Keyed by tab alone the old answer hides it, so
    // the live card never renders and the turn sits blocked with nothing to act on.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    // The restart re-subscribes the transcript, so the read is in flight for a beat.
    activeTab.sessionId = 'session-2'
    setTranscript('loading')
    promptsState.ask = null
    promptsState.detectedAsk = null
    step()

    setTranscript('ready')
    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('retires the dismissal only on the ungated prompt, not the gated one', () => {
    // The paused gate hides the card whenever the agent is not waiting, but a
    // hidden card is no evidence the sticky status prompt cleared. Feeding the
    // gated `ask` in as the detected prompt would read that gap as "prompt gone",
    // retire the dismissal, and bring the answered card back when it reopens.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    promptsState.ask = null
    step()

    promptsState.ask = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('keeps the dismissal while the re-subscribed transcript is still empty', () => {
    // Toggling views re-subscribes the transcript, so a transcript-derived ask
    // reads as null for a beat with chat already visible. Believing that null
    // retires the dismissal and the answered card comes back (#12497).
    expect(controller?.nativeChatAsk).not.toBeNull()
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    // Chat -> terminal.
    viewMode.isTabChatView = () => false
    promptsState.ask = null
    promptsState.detectedAsk = null
    step()

    // Terminal -> chat: observable again, but the transcript read is in flight.
    viewMode.isTabChatView = () => true
    setTranscript('loading')
    step()

    // The read lands and re-derives the same still-pending ask.
    setTranscript('ready')
    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('accepts an answer taken while the first transcript read is still in flight', () => {
    // A status-derived ask renders before any transcript lands, so the load window
    // must stay observable whenever a prompt is actually on screen — otherwise the
    // dismissal is silently dropped and the answered card never goes away.
    act(() => renderer?.unmount())
    setTranscript('loading')
    act(() => {
      renderer = create(createElement(Harness))
    })

    expect(controller?.nativeChatAsk).not.toBeNull()
    act(() => controller?.dismissNativeChatAsk())

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('still retires the dismissal once a settled transcript reports no prompt', () => {
    // The load-window guard must not swallow the genuine reset: a prompt that
    // clears with the read settled means the agent moved on.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    promptsState.ask = null
    promptsState.detectedAsk = null
    step()

    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('keeps the dismissal while a dropped client empties the transcript', () => {
    // `transcriptLoading` is only true for an in-flight read. A dropped client
    // parks the session at 'idle', where the hook withholds `messages` with that
    // flag already false — so the derived prompt reads null for a reason that
    // says nothing about the agent, and the reset effect retired a live dismissal.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('idle')
    promptsState.ask = null
    promptsState.detectedAsk = null
    step()

    // Reconnect: the read lands and the same question is still pending.
    setTranscript('ready')
    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('keeps the dismissal when the first read of a transcript errors', () => {
    // The host forwards an initial-drain failure as an error frame carrying an
    // EMPTY list, and that frame is not terminal — a real snapshot follows once
    // the read recovers. Judging the prompt from that never-populated list
    // retires the dismissal, and the recovered read brings the answered card
    // back over the composer.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('error', 0)
    promptsState.ask = null
    promptsState.detectedAsk = null
    step()

    // The read recovers with the same question still pending.
    setTranscript('ready')
    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })

  it('retires the dismissal when a failed read still reports the last transcript', () => {
    // A read error that lands on top of rows from an earlier read leaves those
    // rows in `messages`, so a prompt that clears under it is real evidence —
    // unlike the never-read empty list of 'idle'/'waiting-session'. Treating
    // every error as unobservable would freeze the dismissal and hide the next
    // identical question for good.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('error')
    promptsState.ask = null
    promptsState.detectedAsk = null
    step()

    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    step()

    expect(controller?.nativeChatAsk).not.toBeNull()
  })

  it('keeps the dismissal while the tab has no provider session yet', () => {
    // 'waiting-session' withholds `messages` the same way, also with
    // transcriptLoading false. The tab still shows chat (resolveMobileNativeChat
    // resolves from `launchAgent` alone), so a live dismissal is on screen for it.
    act(() => controller?.dismissNativeChatAsk())
    expect(controller?.nativeChatAsk).toBeNull()

    setTranscript('waiting-session')
    promptsState.ask = null
    promptsState.detectedAsk = null
    step()

    setTranscript('ready')
    promptsState.ask = PROMPT
    promptsState.detectedAsk = PROMPT
    step()

    expect(controller?.nativeChatAsk).toBeNull()
  })
})
