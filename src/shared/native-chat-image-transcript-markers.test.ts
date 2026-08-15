import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'

function userText(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('normalizeImageTranscriptMessages', () => {
  it('merges the paired [Image: source]/[Image #1] turns into one image-ref turn', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/orca-paste-1-2.png]'),
      userText('b', '[Image #1] describe this')
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/orca-paste-1-2.png' },
      { type: 'text', text: 'describe this' }
    ])
  })

  it('converts a lone [Image: source] turn (no prompt) into an image-ref instead of raw text', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /userhome/me/Pictures/hero-image-2.png]')
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/userhome/me/Pictures/hero-image-2.png' }
    ])
  })

  it('leaves ordinary user text untouched and reuses the input by reference', () => {
    const message = userText('a', 'how about this')
    const messages = [message]
    const out = normalizeImageTranscriptMessages(messages)
    expect(out).toBe(messages)
    expect(out[0]).toBe(message)
    expect(out[0]!.blocks).toBe(message.blocks)
  })

  it('removes a whitespace-only first text block after stripping the marker', () => {
    const out = normalizeImageTranscriptMessages([userText('a', '[Image #1]    ')])

    expect(out[0]?.blocks).toEqual([])
  })

  it('preserves unaffected rows when another row needs normalization', () => {
    const before = userText('before', 'keep this row')
    const marker = userText('marker', '[Image: source: /tmp/image.png]')
    const after = userText('after', 'keep this row too')
    const messages = [before, marker, after]

    const out = normalizeImageTranscriptMessages(messages)

    expect(out).not.toBe(messages)
    expect(out[0]).toBe(before)
    expect(out.at(-1)).toBe(after)
  })

  it('leaves assistant messages untouched', () => {
    const assistant: NativeChatMessage = {
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'text', text: '[Image: source: /tmp/x.png]' }],
      timestamp: 1,
      source: 'transcript'
    }
    expect(normalizeImageTranscriptMessages([assistant])).toEqual([assistant])
  })
})
