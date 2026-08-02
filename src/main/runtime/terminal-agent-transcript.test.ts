// The bounds contract: turns survive so backward paging stays valid, bodies are
// what the character budget spends, and the tail keeps its content.
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  TERMINAL_AGENT_TRANSCRIPT_DEFAULT_TURNS,
  TERMINAL_AGENT_TRANSCRIPT_MAX_BLOCK_CHARS,
  TERMINAL_AGENT_TRANSCRIPT_MAX_CHARS,
  TERMINAL_AGENT_TRANSCRIPT_MAX_TURNS,
  boundAgentTranscriptTurnCount,
  buildTerminalAgentTranscript,
  buildUnavailableAgentTranscript
} from './terminal-agent-transcript'

function message(over: Partial<NativeChatMessage> = {}): NativeChatMessage {
  return {
    id: 'm-1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'hello' }],
    timestamp: 1,
    source: 'transcript',
    ...over
  }
}

function read(messages: NativeChatMessage[], over: Record<string, unknown> = {}) {
  return buildTerminalAgentTranscript({
    handle: 'term-1',
    agent: 'claude',
    sessionId: 'sess-1',
    host: { kind: 'local' },
    path: '/p/sess-1.jsonl',
    messages,
    hasMoreBefore: false,
    previousOffset: null,
    ...over
  })
}

describe('boundAgentTranscriptTurnCount', () => {
  it('defaults, floors at one turn and caps at the maximum window', () => {
    expect(boundAgentTranscriptTurnCount()).toBe(TERMINAL_AGENT_TRANSCRIPT_DEFAULT_TURNS)
    expect(boundAgentTranscriptTurnCount(0)).toBe(1)
    expect(boundAgentTranscriptTurnCount(1_000_000)).toBe(TERMINAL_AGENT_TRANSCRIPT_MAX_TURNS)
    expect(boundAgentTranscriptTurnCount(Number.POSITIVE_INFINITY)).toBe(
      TERMINAL_AGENT_TRANSCRIPT_DEFAULT_TURNS
    )
  })
})

describe('buildTerminalAgentTranscript', () => {
  it('carries the untruncated tool result the terminal never saw', () => {
    const output = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n')
    const result = read([message({ role: 'tool', blocks: [{ type: 'tool-result', output }] })])
    const block = result.turns[0]!.blocks[0]!
    expect(block).toEqual({ kind: 'tool-result', output, isError: false, truncated: false })
    expect(result.available).toBe(true)
    expect(result.limited).toBe(false)
  })

  it('keeps reading order — newest turn last', () => {
    const result = read([
      message({ id: 'a', blocks: [{ type: 'text', text: 'first' }] }),
      message({ id: 'b', blocks: [{ type: 'text', text: 'second' }] })
    ])
    expect(result.turns.map((turn) => turn.id)).toEqual(['a', 'b'])
  })

  it('caps a single oversized body and flags it rather than clipping silently', () => {
    const output = 'x'.repeat(TERMINAL_AGENT_TRANSCRIPT_MAX_BLOCK_CHARS + 500)
    const result = read([message({ role: 'tool', blocks: [{ type: 'tool-result', output }] })])
    const block = result.turns[0]!.blocks[0]!
    expect(block).toMatchObject({ kind: 'tool-result', truncated: true })
    expect(block.kind === 'tool-result' && block.output.length).toBe(
      TERMINAL_AGENT_TRANSCRIPT_MAX_BLOCK_CHARS
    )
    expect(result.limited).toBe(true)
  })

  it('spends the window budget newest-first, so the tail keeps its bodies', () => {
    const body = 'y'.repeat(TERMINAL_AGENT_TRANSCRIPT_MAX_BLOCK_CHARS)
    const count = Math.ceil(TERMINAL_AGENT_TRANSCRIPT_MAX_CHARS / body.length) + 2
    const messages = Array.from({ length: count }, (_, i) =>
      message({ id: `m-${i}`, role: 'tool', blocks: [{ type: 'tool-result', output: body }] })
    )
    const result = read(messages)
    // Every turn survives (paging offsets stay valid); the OLDEST bodies are the
    // ones the budget starved.
    expect(result.turns).toHaveLength(count)
    const newest = result.turns.at(-1)!.blocks[0]!
    const oldest = result.turns[0]!.blocks[0]!
    expect(newest.kind === 'tool-result' && newest.output.length).toBe(body.length)
    expect(oldest.kind === 'tool-result' && oldest.output).toBe('')
    expect(oldest).toMatchObject({ truncated: true })
    expect(result.limited).toBe(true)
  })

  it('serializes tool-call arguments and reports image references', () => {
    const result = read([
      message({
        blocks: [
          { type: 'tool-call', name: 'Bash', input: { command: 'seq 1 120' } },
          { type: 'image-ref', path: '/tmp/shot.png', alt: 'screenshot' }
        ]
      })
    ])
    expect(result.turns[0]!.blocks).toEqual([
      { kind: 'tool-call', name: 'Bash', input: '{"command":"seq 1 120"}', truncated: false },
      { kind: 'image-ref', ref: '/tmp/shot.png', alt: 'screenshot' }
    ])
  })

  it('reports a paging offset only when it returned turns to page from', () => {
    expect(read([], { hasMoreBefore: true, previousOffset: 900 }).previousOffset).toBeNull()
    expect(read([message()], { hasMoreBefore: true, previousOffset: 900 })).toMatchObject({
      hasMoreBefore: true,
      previousOffset: 900
    })
  })

  it('always declares that a transcript is not the pane screen', () => {
    expect(read([message()]).blindSpots.map((spot) => spot.capability)).toEqual([
      'agent-screen-state'
    ])
  })
})

describe('buildUnavailableAgentTranscript', () => {
  it('is a named refusal that still reports resolved identity', () => {
    const result = buildUnavailableAgentTranscript({
      handle: 'term-1',
      unavailable: 'remote-host',
      detail: 'lives on conn-7',
      agent: 'claude',
      sessionId: 'sess-1',
      host: { kind: 'ssh', connectionId: 'conn-7' },
      path: '/home/u/sess-1.jsonl'
    })
    expect(result).toMatchObject({
      available: false,
      unavailable: 'remote-host',
      detail: 'lives on conn-7',
      agent: 'claude',
      sessionId: 'sess-1',
      turns: []
    })
    // The blind spot travels with a refusal too: it is still not a screen.
    expect(result.blindSpots).toHaveLength(1)
  })
})
