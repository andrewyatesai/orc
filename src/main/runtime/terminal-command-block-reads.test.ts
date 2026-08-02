import { describe, expect, it } from 'vitest'
import {
  TERMINAL_BLOCK_TEXT_DEFAULT_LINES,
  TERMINAL_BLOCK_TEXT_MAX_LINES,
  buildTerminalCommandBlockText,
  buildTerminalCommandBlocksResult,
  type TerminalTranscriptWindow
} from './terminal-command-block-reads'
import type { TerminalCommandBlockRecord } from './terminal-command-blocks'

function transcript(lines: string[], linesTotal = lines.length): TerminalTranscriptWindow {
  return { lines, linesTotal }
}

const finished = (over: Partial<TerminalCommandBlockRecord> = {}): TerminalCommandBlockRecord => ({
  index: 0,
  command: 'npm test',
  exitCode: 0,
  startCursor: 1,
  endCursor: 3,
  startedAt: 100,
  endedAt: 200,
  ...over
})

describe('terminal command blocks result', () => {
  it('reports the transcript floor a caller must stay above', () => {
    const result = buildTerminalCommandBlocksResult(
      {
        blocks: [finished()],
        totalObserved: 9,
        evictedCount: 3,
        shellIntegrationSeen: true
      },
      transcript(['a', 'b', 'c'], 103)
    )
    expect(result.available).toBe(true)
    expect(result.oldestCursor).toBe('100')
    expect(result.latestCursor).toBe('103')
    expect(result.totalObserved).toBe(9)
    expect(result.evictedCount).toBe(3)
  })

  it('serializes cursors as strings so they feed terminal read --cursor verbatim', () => {
    const result = buildTerminalCommandBlocksResult(
      {
        blocks: [finished()],
        totalObserved: 1,
        evictedCount: 0,
        shellIntegrationSeen: true
      },
      transcript(['a', 'b', 'c'])
    )
    expect(result.blocks[0]).toMatchObject({
      startCursor: '1',
      endCursor: '3',
      running: false,
      outputLineCount: 2
    })
  })

  it('says why blocks are unavailable when the pane has no transcript record', () => {
    const result = buildTerminalCommandBlocksResult(
      {
        blocks: [],
        totalObserved: 0,
        evictedCount: 0,
        shellIntegrationSeen: false
      },
      null
    )
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('no-pty-record')
  })

  it('distinguishes "no command seen" from "no shell integration"', () => {
    const result = buildTerminalCommandBlocksResult(
      {
        blocks: [],
        totalObserved: 0,
        evictedCount: 0,
        shellIntegrationSeen: false
      },
      transcript(['a'])
    )
    expect(result.available).toBe(true)
    expect(result.shellIntegrationSeen).toBe(false)
  })
})

describe('terminal command block text', () => {
  it('returns exactly the block’s transcript slice', () => {
    const result = buildTerminalCommandBlockText(
      finished({ startCursor: 1, endCursor: 3 }),
      transcript(['prompt', 'line one', 'line two', 'next prompt'])
    )
    expect(result.outcome).toBe('text')
    expect(result.lines).toEqual(['line one', 'line two'])
    expect(result.firstCursor).toBe('1')
    expect(result.nextCursor).toBe('3')
    expect(result.truncated).toBe(false)
  })

  it('returns output so far for a running block and says it is running', () => {
    const result = buildTerminalCommandBlockText(
      finished({ endCursor: null, exitCode: null }),
      transcript(['prompt', 'partial output'])
    )
    expect(result.outcome).toBe('text')
    expect(result.running).toBe(true)
    expect(result.lines).toEqual(['partial output'])
  })

  it('reports eviction rather than an empty result when the whole block aged out', () => {
    const result = buildTerminalCommandBlockText(
      finished({ startCursor: 1, endCursor: 3 }),
      transcript(['x', 'y'], 502)
    )
    expect(result.outcome).toBe('evicted')
    expect(result.lines).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('marks a partially evicted block as truncated but still returns what survives', () => {
    const result = buildTerminalCommandBlockText(
      finished({ startCursor: 0, endCursor: 6 }),
      transcript(['c', 'd', 'e'], 6)
    )
    expect(result.outcome).toBe('text')
    expect(result.truncated).toBe(true)
    expect(result.lines).toEqual(['c', 'd', 'e'])
    expect(result.firstCursor).toBe('3')
  })

  it('names a missing block instead of returning empty text', () => {
    expect(buildTerminalCommandBlockText(null, transcript(['a'])).outcome).toBe('no-such-block')
    expect(buildTerminalCommandBlockText(finished(), null).outcome).toBe('no-pty-record')
  })

  it('bounds long output and reports that it was limited', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `row ${i}`)
    const result = buildTerminalCommandBlockText(
      finished({ startCursor: 0, endCursor: 3000 }),
      transcript(lines, 3000)
    )
    expect(result.lines).toHaveLength(TERMINAL_BLOCK_TEXT_DEFAULT_LINES)
    expect(result.limited).toBe(true)
    expect(result.nextCursor).toBe(String(TERMINAL_BLOCK_TEXT_DEFAULT_LINES))
  })

  it('honours an explicit larger limit up to the cap', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `row ${i}`)
    const result = buildTerminalCommandBlockText(
      finished({ startCursor: 0, endCursor: 3000 }),
      transcript(lines, 3000),
      { limit: 99_999 }
    )
    expect(result.lines).toHaveLength(TERMINAL_BLOCK_TEXT_MAX_LINES)
  })

  it('always names the channels it cannot serve', () => {
    const capabilities = buildTerminalCommandBlockText(
      finished(),
      transcript(['a', 'b', 'c', 'd'])
    ).blindSpots.map((spot) => spot.capability)
    expect(capabilities).toContain('agent-collapsed-output')
  })
})

describe('a wiped transcript is a blind spot, never an empty answer', () => {
  // The PTY exited (or the buffer was cleared): the block records survive, the text
  // does not. Answering "that command printed nothing" would look like a fact.
  it('refuses to report a block with declared output as empty text', () => {
    const result = buildTerminalCommandBlockText(finished(), transcript([], 0))

    expect(result.outcome).toBe('evicted')
    expect(result.lines).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('still lists what ran, but says the text is unreadable', () => {
    const result = buildTerminalCommandBlocksResult(
      { blocks: [finished()], totalObserved: 1, evictedCount: 0, shellIntegrationSeen: true },
      transcript([], 0)
    )

    // The blocks are the surviving evidence of WHAT ran; only the output is gone.
    expect(result.blocks).toHaveLength(1)
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('transcript-wiped')
  })

  it('keeps a genuinely empty pane available — nothing ran, nothing lost', () => {
    const result = buildTerminalCommandBlocksResult(
      { blocks: [], totalObserved: 0, evictedCount: 0, shellIntegrationSeen: false },
      transcript([], 0)
    )

    expect(result.available).toBe(true)
    expect(result.unavailable).toBeUndefined()
  })
})
