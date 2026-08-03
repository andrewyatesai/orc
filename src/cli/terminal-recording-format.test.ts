import { describe, expect, it } from 'vitest'
import {
  formatRecordingList,
  formatRecordingStart,
  formatRecordingStop
} from './terminal-recording-format'
import {
  TERMINAL_RECORDING_BLIND_SPOTS,
  TERMINAL_RECORDING_SCHEMA_VERSION,
  terminalRecordingPlayback,
  type TerminalRecordingSummary
} from '../shared/terminal-recording-protocol'

const RECORDING: TerminalRecordingSummary = {
  id: 'rec_1',
  handle: 'term_a',
  state: 'finalized',
  path: '/tmp/casts/rec_1.cast',
  startedAt: 1_000,
  endedAt: 6_000,
  durationMs: 5_000,
  cols: 120,
  rows: 40,
  sizeSource: 'engine',
  bytesCaptured: 4_096,
  eventsCaptured: 40,
  bytesDroppedAfterCap: 0,
  stopReason: 'requested',
  caps: { maxDurationMs: 300_000, maxBytes: 8_388_608, maxEvents: 20_000 },
  fileBytes: 5_000,
  writeError: null
}

describe('orca terminal record formatting', () => {
  it('prints the conversion commands verbatim so they can be pasted', () => {
    const text = formatRecordingStop({
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      stopped: true,
      detail: null,
      recording: RECORDING,
      playback: terminalRecordingPlayback('/tmp/casts/rec_1.cast'),
      blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
    })
    expect(text).toContain('agg /tmp/casts/rec_1.cast /tmp/casts/rec_1.gif')
    expect(text).toContain('ffmpeg -y -i /tmp/casts/rec_1.gif')
    expect(text).toContain('asciinema play /tmp/casts/rec_1.cast')
    expect(text).toContain('not a pixel capture')
  })

  it('shouts which cap ended a recording, and what was lost after it', () => {
    const text = formatRecordingStop({
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      stopped: true,
      detail: null,
      recording: { ...RECORDING, stopReason: 'byte-cap', bytesDroppedAfterCap: 2_048 },
      playback: terminalRecordingPlayback('/tmp/casts/rec_1.cast'),
      blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
    })
    expect(text).toContain('ENDED BY THE BYTE CAP')
    expect(text).toContain('2048 further bytes')
  })

  it('a stopped-but-unwritten recording never reads as a finished file', () => {
    const text = formatRecordingStop({
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      stopped: true,
      unavailable: 'write-failed',
      detail: 'The capture finished but the cast could not be written: ENOSPC',
      recording: { ...RECORDING, path: null, fileBytes: null, writeError: 'ENOSPC' },
      playback: null,
      blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
    })
    expect(text).toContain('NOT WRITTEN: ENOSPC')
    expect(text).toContain('No file to convert')
  })

  it('a refusal prints the named cause, not "no recording"', () => {
    const text = formatRecordingStart({
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      started: false,
      unavailable: 'bytes-not-local',
      detail: 'This runtime holds no ingest state for that PTY.',
      recording: null,
      blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
    })
    expect(text).toContain('bytes-not-local')
    expect(text).toContain('This runtime holds no ingest state')
  })

  it('flags assumed geometry rather than presenting it as observed', () => {
    const text = formatRecordingStart({
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      started: true,
      detail: null,
      recording: { ...RECORDING, state: 'recording', sizeSource: 'assumed', stopReason: null },
      blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
    })
    expect(text).toContain('ASSUMED')
    expect(text).toContain('orca terminal record-stop --terminal term_a')
  })

  it('an empty list still says where recordings live and how long they last', () => {
    const text = formatRecordingList({
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      available: true,
      detail: null,
      recordings: [],
      directory: '/tmp/casts',
      pathsAreOnRuntimeHost: true,
      retentionMs: 24 * 60 * 60 * 1000,
      retainedFileLimit: 32,
      filesFromOtherRuns: 2,
      blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
    })
    expect(text).toContain('No recordings from this runtime')
    expect(text).toContain('/tmp/casts')
    expect(text).toContain('on the runtime host')
    expect(text).toContain('24h')
    expect(text).toContain('2 cast file(s) in the store were written by an earlier run')
  })
})
