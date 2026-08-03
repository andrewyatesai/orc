import { describe, expect, it } from 'vitest'
import { parseAsciicastV2 } from './asciicast-v2'
import {
  TerminalCastRecorderLedger,
  TERMINAL_RECORDING_ASSUMED_COLS,
  TERMINAL_RECORDING_MAX_BYTES,
  type TerminalCastFinalized
} from './terminal-cast-recorder'

function ledgerWithSink(retention?: number): {
  ledger: TerminalCastRecorderLedger
  finalized: TerminalCastFinalized[]
} {
  const ledger =
    retention === undefined
      ? new TerminalCastRecorderLedger()
      : new TerminalCastRecorderLedger(retention)
  const finalized: TerminalCastFinalized[] = []
  ledger.setSink((entry) => finalized.push(entry))
  return { ledger, finalized }
}

const START = 1_700_000_000_000

describe('TerminalCastRecorderLedger', () => {
  it('produces a valid asciicast whose times are relative to the start', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a', engineSize: { cols: 120, rows: 40 } })
    ledger.ingest('pty-1', 'first', START + 250)
    ledger.ingest('pty-1', 'second', START + 1_500)
    ledger.stop('pty-1', START + 2_000, 'requested')

    expect(finalized).toHaveLength(1)
    const parsed = parseAsciicastV2(finalized[0].cast)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.header).toMatchObject({
      version: 2,
      width: 120,
      height: 40,
      timestamp: Math.floor(START / 1000),
      duration: 2
    })
    expect(parsed.events).toEqual([
      { time: 0.25, code: 'o', data: 'first' },
      { time: 1.5, code: 'o', data: 'second' }
    ])
  })

  it('falls back requested -> assumed for geometry and names which it used', () => {
    const { ledger } = ledgerWithSink()
    const requested = ledger.start('pty-1', START, {
      handle: 'term_a',
      engineSize: null,
      requestedSize: { cols: 100, rows: 30 }
    })
    expect(requested).toMatchObject({ cols: 100, rows: 30, sizeSource: 'requested' })

    const assumed = ledger.start('pty-2', START, { handle: 'term_b' })
    expect(assumed).toMatchObject({
      cols: TERMINAL_RECORDING_ASSUMED_COLS,
      sizeSource: 'assumed'
    })
  })

  it('emits a resize event when the engine size changes mid-recording', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a', engineSize: { cols: 80, rows: 24 } })
    ledger.ingest('pty-1', 'a', START + 10, { cols: 80, rows: 24 })
    ledger.ingest('pty-1', 'b', START + 20, { cols: 100, rows: 30 })
    ledger.ingest('pty-1', 'c', START + 30, { cols: 100, rows: 30 })
    ledger.stop('pty-1', START + 40, 'requested')

    const parsed = parseAsciicastV2(finalized[0].cast)
    expect(parsed.ok && parsed.events.map((event) => `${event.code}:${event.data}`)).toEqual([
      'o:a',
      'r:100x30',
      'o:b',
      'o:c'
    ])
  })

  it('refuses a second recording on the same pane', () => {
    const { ledger } = ledgerWithSink()
    expect(ledger.start('pty-1', START, { handle: 'term_a' })).not.toBeNull()
    expect(ledger.start('pty-1', START + 1, { handle: 'term_a' })).toBeNull()
  })

  it('ends on the byte cap, writes immediately, and counts what came after', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a', maxBytes: 10 })
    ledger.ingest('pty-1', '1234567890AB', START + 5)
    // The cap fires without anyone calling stop: the cast is already handed off.
    expect(finalized).toHaveLength(1)
    expect(finalized[0].capture.stopReason).toBe('byte-cap')

    ledger.ingest('pty-1', 'still printing', START + 10)
    const capture = ledger.stop('pty-1', START + 20, 'requested')
    expect(capture).toMatchObject({ stopReason: 'byte-cap', bytesDroppedAfterCap: 14 })
    // Stopping a cap-ended recording must not produce a second cast.
    expect(finalized).toHaveLength(1)
  })

  it('ends on the event cap', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a', maxEvents: 2 })
    ledger.ingest('pty-1', 'a', START + 1)
    ledger.ingest('pty-1', 'b', START + 2)
    ledger.ingest('pty-1', 'c', START + 3)
    expect(finalized[0].capture.stopReason).toBe('event-cap')
    expect(finalized[0].capture.eventsCaptured).toBe(2)
  })

  it('ends on the duration cap without admitting the chunk that crossed it', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a', maxDurationMs: 1_000 })
    ledger.ingest('pty-1', 'inside', START + 900)
    ledger.ingest('pty-1', 'outside', START + 1_100)
    expect(finalized[0].capture.stopReason).toBe('duration-cap')
    expect(finalized[0].cast).toContain('inside')
    expect(finalized[0].cast).not.toContain('outside')
    expect(ledger.captureFor('pty-1')?.bytesDroppedAfterCap).toBe(7)
  })

  it('closes a capture whose duration cap expired while the pane stayed quiet', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a', maxDurationMs: 1_000 })
    ledger.ingest('pty-1', 'hello', START + 10)
    // No further output ever arrives, so `ingest` never runs again — the cap
    // used to be checked only there, leaving this capture open forever.
    ledger.sweep(START + 5_000)
    expect(ledger.isRecording('pty-1')).toBe(false)
    expect(finalized[0].capture.stopReason).toBe('duration-cap')
    // Stamped at the cap, not at the moment someone noticed.
    expect(finalized[0].capture.endedAt).toBe(START + 1_000)
    expect(finalized[0].cast).toContain('hello')
  })

  it('leaves a capture inside its duration cap alone', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a', maxDurationMs: 10_000 })
    ledger.sweep(START + 500)
    expect(ledger.isRecording('pty-1')).toBe(true)
    expect(finalized).toHaveLength(0)
  })

  it('counts bytes, not UTF-16 units, against the byte cap', () => {
    const { ledger } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a' })
    // Four astral-plane chars: 8 UTF-16 units, 16 UTF-8 bytes.
    ledger.ingest('pty-1', '\u{1F600}\u{1F600}\u{1F600}\u{1F600}', START + 1)
    expect(ledger.captureFor('pty-1')?.bytesCaptured).toBe(16)
  })

  it('clamps caps to their ceilings and reports the applied values', () => {
    const { ledger } = ledgerWithSink()
    const capture = ledger.start('pty-1', START, {
      handle: 'term_a',
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxDurationMs: -1
    })
    expect(capture?.caps.maxBytes).toBe(TERMINAL_RECORDING_MAX_BYTES)
    // A nonsense value falls back to the default rather than disabling the cap.
    expect(capture?.caps.maxDurationMs).toBeGreaterThan(0)
  })

  it('stop on a pane that never recorded returns null', () => {
    const { ledger, finalized } = ledgerWithSink()
    expect(ledger.stop('pty-unknown', START, 'requested')).toBeNull()
    expect(finalized).toHaveLength(0)
  })

  it('writes the cast when the PTY is dropped mid-recording', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a' })
    ledger.ingest('pty-1', 'partial output', START + 10)
    ledger.dropPty('pty-1', START + 20, 'pty-exit')
    expect(finalized).toHaveLength(1)
    expect(finalized[0].capture.stopReason).toBe('pty-exit')
    expect(finalized[0].cast).toContain('partial output')
  })

  it('ignores bytes for panes with no recording, and does not fabricate one', () => {
    const { ledger, finalized } = ledgerWithSink()
    ledger.ingest('pty-quiet', 'output nobody asked to record', START)
    expect(finalized).toHaveLength(0)
    expect(ledger.captureFor('pty-quiet')).toBeNull()
  })

  it('lists active and finished captures newest-start first', () => {
    const { ledger } = ledgerWithSink()
    ledger.start('pty-1', START, { handle: 'term_a' })
    ledger.stop('pty-1', START + 5, 'requested')
    ledger.start('pty-2', START + 10, { handle: 'term_b' })
    expect(ledger.captures().map((capture) => capture.handle)).toEqual(['term_b', 'term_a'])
    expect(ledger.captures().map((capture) => capture.stopReason)).toEqual([null, 'requested'])
  })

  it('bounds the finished-capture memory', () => {
    const { ledger } = ledgerWithSink(2)
    for (const index of [1, 2, 3]) {
      ledger.start(`pty-${index}`, START + index, { handle: `term_${index}` })
      ledger.stop(`pty-${index}`, START + index + 1, 'requested')
    }
    expect(ledger.captures()).toHaveLength(2)
    expect(ledger.captureFor('pty-1')).toBeNull()
  })
})
