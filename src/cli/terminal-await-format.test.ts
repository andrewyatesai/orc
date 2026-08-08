import { describe, expect, it } from 'vitest'
import { formatTerminalAwait, type CliTerminalAwaitOutcome } from './terminal-await-format'
import {
  decodeTerminalEventCursor,
  encodeTerminalEventCursor
} from '../shared/terminal-event-cursor-token'

const cursor = { runtimeId: 'rt_1', ptyIncarnationId: 'inc_1', eventSeq: 7 }

function outcome(overrides: Partial<CliTerminalAwaitOutcome> = {}): CliTerminalAwaitOutcome {
  return {
    outcome: 'event',
    terminal: 'term_a',
    event: { kind: 'agent-idle', eventSeq: 7, at: 1 },
    cursors: [{ terminal: 'term_a', cursor }],
    ...overrides
  }
}

describe('terminal event cursor token', () => {
  it('round-trips', () => {
    expect(decodeTerminalEventCursor(encodeTerminalEventCursor(cursor))).toEqual(cursor)
  })

  it.each([
    ['garbage', 'not-a-token'],
    ['a non-object', encodeTerminalEventCursor(null as never)],
    ['a negative ordinal', encodeTerminalEventCursor({ ...cursor, eventSeq: -1 })],
    ['a fractional ordinal', encodeTerminalEventCursor({ ...cursor, eventSeq: 1.5 })],
    ['a missing incarnation', encodeTerminalEventCursor({ ...cursor, ptyIncarnationId: 1 as never })]
  ])('refuses %s rather than coercing a resume position', (_label, token) => {
    expect(decodeTerminalEventCursor(token)).toBeNull()
  })
})

describe('formatTerminalAwait', () => {
  it.each([
    ['event', outcome()],
    ['gap', outcome({ outcome: 'gap', reason: 'evicted' })],
    ['exit', outcome({ outcome: 'exit' })],
    ['timeout', outcome({ outcome: 'timeout' })],
    [
      'unsupported',
      outcome({ outcome: 'unsupported', kinds: ['bell'], reason: 'no-side-effect-consumer' })
    ]
  ])('prints resumable cursors on a %s outcome', (_label, value) => {
    // Every outcome destroys the watch, so every outcome has to hand back the
    // position to re-arm from or the caller loses what happens next.
    const printed = formatTerminalAwait({ await: value })
    expect(printed).toContain('--cursor')
    expect(printed).toContain(encodeTerminalEventCursor(cursor))
  })

  it('says a gap lost history rather than printing it as an ordinary event', () => {
    const printed = formatTerminalAwait({ await: outcome({ outcome: 'gap', reason: 'evicted' }) })
    expect(printed).toContain('gap (evicted)')
    expect(printed).toContain('history was lost')
  })

  it('names the kinds this runtime cannot produce', () => {
    const printed = formatTerminalAwait({
      await: outcome({ outcome: 'unsupported', kinds: ['bell'], reason: 'no-side-effect-consumer' })
    })
    expect(printed).toContain('bell')
    expect(printed).toContain('no-side-effect-consumer')
  })
})
