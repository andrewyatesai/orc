import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

function userTextMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

function assistantTextMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

// Rebinding is the point of #12639: when the optimistic image bubble is reconciled
// away, its phone-local previews must survive on the authoritative transcript turn
// so the marker turn (host path only) can still paint the sent photo.
describe('useMobileNativeChatDrafts image preview retention', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({ messages = [] }: { messages?: NativeChatMessage[] }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages
    })
    return null
  }

  async function mount(): Promise<void> {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, {}))
      })
    } finally {
      consoleSpy.mockRestore()
    }
  }

  async function withMessages(messages: NativeChatMessage[]): Promise<void> {
    await act(async () => renderer?.update(createElement(Harness, { messages })))
  }

  it('rebinds an image-only preview to the [Image: source] turn once its echo lands', async () => {
    await mount()
    await withMessages([assistantTextMessage('a1', 'hi')])
    const origin = state?.captureSendOrigin('')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, '', ['file:///a.jpg'])
      }
    })
    // Nothing landed yet: the preview still rides the optimistic bubble, not a turn.
    expect(state?.imagePreviewsByMessageId).toEqual({})

    await withMessages([
      assistantTextMessage('a1', 'hi'),
      userTextMessage('u1', '[Image: source: /tmp/a.png]')
    ])
    // Bubble cleared, but the phone-local URI is retained against the turn that
    // absorbed the echo so the render layer can still paint the photo.
    expect(state?.pending).toEqual([])
    expect(state?.imagePreviewsByMessageId).toEqual({ u1: ['file:///a.jpg'] })
  })

  it('rebinds a captioned image preview to the [Image #N] prompt turn', async () => {
    await mount()
    await withMessages([assistantTextMessage('a1', 'hi')])
    const origin = state?.captureSendOrigin('look at this')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, 'look at this', ['file:///a.jpg'])
      }
    })

    await withMessages([
      assistantTextMessage('a1', 'hi'),
      userTextMessage('u1', '[Image: source: /tmp/a.png]'),
      userTextMessage('u2', '[Image #1] look at this')
    ])
    // The caption turn (u2) is the id that survives normalization as the authoritative
    // turn, so the preview binds there — matching the render layer's message keying.
    expect(state?.pending).toEqual([])
    expect(state?.imagePreviewsByMessageId).toEqual({ u2: ['file:///a.jpg'] })
  })

  it('spreads a multi-image send across one echo turn per photo, in send order', async () => {
    await mount()
    await withMessages([assistantTextMessage('a1', 'hi')])
    // One send rides two photos (the composer maps every chip's previewUri).
    const origin = state?.captureSendOrigin('')
    act(() => {
      if (origin) {
        state?.acceptSend(origin, '', ['file:///a.jpg', 'file:///b.jpg'])
      }
    })

    await withMessages([
      assistantTextMessage('a1', 'hi'),
      userTextMessage('u1', '[Image: source: /tmp/a.png]'),
      userTextMessage('u2', '[Image: source: /tmp/b.png]')
    ])
    expect(state?.pending).toEqual([])
    expect(state?.imagePreviewsByMessageId).toEqual({
      u1: ['file:///a.jpg'],
      u2: ['file:///b.jpg']
    })
  })
})
