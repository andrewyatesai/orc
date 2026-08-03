import { describe, expect, it } from 'vitest'
import {
  buildRecordingList,
  refuseRecordingStart,
  resolveRecordingTap,
  startedRecording,
  stoppedRecording,
  toRecordingSummary
} from './terminal-recording-report'
import type { TerminalCastCapture } from './terminal-cast-recorder'

const CAPTURE: TerminalCastCapture = {
  id: 'rec_1',
  ptyId: 'pty-1',
  handle: 'term_a',
  startedAt: 1_000,
  endedAt: 4_000,
  cols: 80,
  rows: 24,
  sizeSource: 'engine',
  bytesCaptured: 512,
  eventsCaptured: 12,
  bytesDroppedAfterCap: 0,
  stopReason: 'requested',
  caps: { maxDurationMs: 1_000, maxBytes: 2_000, maxEvents: 30 }
}

function summary(
  overrides: Partial<ReturnType<typeof toRecordingSummary>> = {}
): ReturnType<typeof toRecordingSummary> {
  return { ...toRecordingSummary(CAPTURE, null), ...overrides }
}

describe('resolveRecordingTap', () => {
  it('names a pane this runtime does not host, instead of recording nothing', () => {
    const tap = resolveRecordingTap({
      paneExists: false,
      ptyId: null,
      bytesObservedHere: false,
      paneRecordIsLocal: false
    })
    expect(tap).toMatchObject({ ok: false, reason: 'pane-not-hosted-here' })
    expect(tap.ok === false && tap.detail).toContain('remote runtime')
  })

  it('distinguishes a pane with no PTY yet from one this runtime cannot tap', () => {
    expect(
      resolveRecordingTap({
        paneExists: true,
        ptyId: null,
        bytesObservedHere: false,
        paneRecordIsLocal: false
      })
    ).toMatchObject({ ok: false, reason: 'no-pty' })
    const untapped = resolveRecordingTap({
      paneExists: true,
      ptyId: 'pty-9',
      bytesObservedHere: false,
      paneRecordIsLocal: false
    })
    expect(untapped).toMatchObject({ ok: false, reason: 'bytes-not-local' })
    expect(untapped.ok === false && untapped.detail).toContain('capture nothing')
  })

  it('accepts a pane this runtime ingests, and marks the tap proven', () => {
    expect(
      resolveRecordingTap({
        paneExists: true,
        ptyId: 'pty-1',
        bytesObservedHere: true,
        paneRecordIsLocal: true
      })
    ).toEqual({ ok: true, ptyId: 'pty-1', tapProven: true })
  })

  // The false-refusal this guard used to produce: a local pane that has simply
  // not spoken yet is not a foreign pane, and must still be recordable.
  it('records a quiet local pane, but does not claim the tap is proven', () => {
    expect(
      resolveRecordingTap({
        paneExists: true,
        ptyId: 'pty-2',
        bytesObservedHere: false,
        paneRecordIsLocal: true
      })
    ).toEqual({ ok: true, ptyId: 'pty-2', tapProven: false })
  })
})

describe('unproven taps and empty casts', () => {
  it('start on an unproven tap says so and carries the blind spot', () => {
    const started = startedRecording(summary({ eventsCaptured: 0 }), false)
    expect(started.started).toBe(true)
    expect(started.detail).toContain('unverified')
    expect(started.blindSpots.map((spot) => spot.reason)).toContain('tap-not-proven')
  })

  it('a zero-event stop is reported as ambiguous rather than as silence', () => {
    const stopped = stoppedRecording(summary({ eventsCaptured: 0, path: '/tmp/cast.cast' }))
    expect(stopped.stopped).toBe(true)
    expect(stopped.detail).toContain('zero events')
    expect(stopped.blindSpots.map((spot) => spot.reason)).toContain('tap-not-proven')
  })

  it('a stop that captured output stays clean', () => {
    const stopped = stoppedRecording(summary({ eventsCaptured: 4, path: '/tmp/cast.cast' }))
    expect(stopped.detail).toBeNull()
    expect(stopped.blindSpots.map((spot) => spot.reason)).not.toContain('tap-not-proven')
  })
})

describe('recording results', () => {
  it('every start and stop carries the content-not-pixels blind spot', () => {
    const started = startedRecording(toRecordingSummary(CAPTURE, null))
    const refused = refuseRecordingStart('already-recording', 'busy')
    for (const result of [started, refused]) {
      expect(result.blindSpots.map((spot) => spot.reason)).toContain('cast-is-content-not-pixels')
      expect(result.blindSpots.map((spot) => spot.reason)).toContain(
        'inline-image-sequences-not-replayed'
      )
    }
  })

  it('reports a written cast with the exact conversion commands', () => {
    const stopped = stoppedRecording(
      toRecordingSummary(CAPTURE, { path: '/tmp/casts/rec_1.cast', fileBytes: 900, error: null })
    )
    expect(stopped.stopped).toBe(true)
    expect(stopped.unavailable).toBeUndefined()
    expect(stopped.playback?.gif).toBe('agg /tmp/casts/rec_1.cast /tmp/casts/rec_1.gif')
    expect(stopped.playback?.mp4).toContain('/tmp/casts/rec_1.gif')
    expect(stopped.playback?.mp4).toContain('/tmp/casts/rec_1.mp4')
    expect(stopped.playback?.play).toBe('asciinema play /tmp/casts/rec_1.cast')
  })

  it('a capture whose write failed is stopped AND unavailable, never a bare success', () => {
    const stopped = stoppedRecording(
      toRecordingSummary(CAPTURE, { path: null, fileBytes: null, error: 'ENOSPC' })
    )
    expect(stopped.stopped).toBe(true)
    expect(stopped.unavailable).toBe('write-failed')
    expect(stopped.detail).toContain('ENOSPC')
    expect(stopped.playback).toBeNull()
    expect(stopped.recording?.bytesCaptured).toBe(512)
  })

  it('a capture with no store at all is distinguished from a failed write', () => {
    const stopped = stoppedRecording(toRecordingSummary(CAPTURE, null))
    expect(stopped.unavailable).toBe('store-unavailable')
  })

  it('summarises state and duration from the capture', () => {
    expect(toRecordingSummary(CAPTURE, null)).toMatchObject({
      state: 'finalized',
      durationMs: 3_000,
      path: null
    })
    expect(toRecordingSummary({ ...CAPTURE, stopReason: null, endedAt: null }, null)).toMatchObject(
      {
        state: 'recording',
        durationMs: 0
      }
    )
  })

  it('a list with no store still lists what was captured, and says why there is no path', () => {
    const list = buildRecordingList({
      recordings: [toRecordingSummary(CAPTURE, null)],
      directory: null,
      directoryError: 'EACCES',
      filesFromOtherRuns: 0
    })
    expect(list.available).toBe(false)
    expect(list.unavailable).toBe('store-unavailable')
    expect(list.detail).toContain('EACCES')
    expect(list.recordings).toHaveLength(1)
    expect(list.pathsAreOnRuntimeHost).toBe(true)
  })

  it('reports casts from earlier runs as a count rather than inventing entries', () => {
    const list = buildRecordingList({
      recordings: [],
      directory: '/tmp/casts',
      directoryError: null,
      filesFromOtherRuns: 3
    })
    expect(list).toMatchObject({ available: true, filesFromOtherRuns: 3, recordings: [] })
    expect(list.retentionMs).toBeGreaterThan(0)
    expect(list.retainedFileLimit).toBeGreaterThan(0)
  })
})
