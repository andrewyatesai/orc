/**
 * Per-PTY asciicast recorder — the capture half of `terminal.record`
 * (docs/reference/alab-agent-visibility.md §7).
 *
 * It taps the bytes `OrcaRuntimeService.onPtyData` already parses for every
 * local, daemon and SSH pane, exactly as the OSC-133 block ledger does, rather
 * than inventing a second subscription. That is also why a pane whose bytes do
 * NOT pass through this runtime cannot be recorded here at all: there is no
 * stream to tap, and the runtime refuses by name instead of opening a capture
 * that would look like a silent terminal.
 *
 * A recording is unbounded output by nature, so three caps bound it — duration,
 * bytes, events — and whichever fires closes the capture, hands the finished
 * cast to the sink immediately (so a cap-ended recording is on disk without
 * anyone calling stop), and is reported as the stop reason. Output arriving
 * after that keeps accruing into `bytesDroppedAfterCap`: a capped cast that
 * reported nothing would read exactly like a complete one.
 *
 * Pure module: the clock is passed in and nothing here touches the filesystem.
 * Writing is `terminal-recording-store.ts`.
 */
import {
  ASCIICAST_VERSION,
  asciicastResizeData,
  asciicastTimeSeconds,
  encodeAsciicast,
  type AsciicastEvent,
  type AsciicastHeader
} from './asciicast-v2'
import type {
  TerminalRecordingCaps,
  TerminalRecordingSizeSource,
  TerminalRecordingStopReason
} from '../../shared/terminal-recording-protocol'

/** Five minutes of a coding agent's TUI is a long demo and a large cast; the
 *  ceiling is an hour for a deliberate unattended run. */
export const TERMINAL_RECORDING_DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000
export const TERMINAL_RECORDING_MAX_DURATION_MS = 60 * 60 * 1000
/** A repainting TUI emits far more bytes than it shows; 8 MiB is minutes of
 *  spinner frames and still fits in memory until the cast is written. */
export const TERMINAL_RECORDING_DEFAULT_MAX_BYTES = 8 * 1024 * 1024
export const TERMINAL_RECORDING_MAX_BYTES = 64 * 1024 * 1024
export const TERMINAL_RECORDING_DEFAULT_MAX_EVENTS = 20_000
export const TERMINAL_RECORDING_MAX_EVENTS = 200_000
/** Cast geometry when nothing can tell us the pane's size — the standard
 *  terminal default, reported as `assumed` so playback geometry is never
 *  presented as an observed fact. */
export const TERMINAL_RECORDING_ASSUMED_COLS = 80
export const TERMINAL_RECORDING_ASSUMED_ROWS = 24
/** Finished captures kept for reporting after their cast was handed off. */
export const TERMINAL_RECORDING_CAPTURE_RETENTION = 32

export type TerminalCastSize = { cols: number; rows: number }

export type TerminalCastStartOptions = {
  handle: string
  /** Engine size when the pane has a live headless emulator. */
  engineSize?: TerminalCastSize | null
  /** Caller-declared geometry, used only when the engine cannot answer. */
  requestedSize?: TerminalCastSize | null
  title?: string | null
  maxDurationMs?: number
  maxBytes?: number
  maxEvents?: number
}

export type TerminalCastCapture = {
  id: string
  ptyId: string
  handle: string
  startedAt: number
  endedAt: number | null
  cols: number
  rows: number
  sizeSource: TerminalRecordingSizeSource
  bytesCaptured: number
  eventsCaptured: number
  bytesDroppedAfterCap: number
  stopReason: TerminalRecordingStopReason | null
  caps: TerminalRecordingCaps
}

export type TerminalCastFinalized = {
  capture: TerminalCastCapture
  /** The complete asciicast v2 document, ready to write. */
  cast: string
}

/** Called once per recording, at close. Errors are the sink's to report — the
 *  ledger must not lose a capture because a write failed. */
export type TerminalCastSink = (finalized: TerminalCastFinalized) => void

type ActiveRecording = TerminalCastCapture & {
  title: string | null
  events: AsciicastEvent[]
  lastSize: TerminalCastSize
}

function clamp(requested: number | undefined, fallback: number, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return fallback
  }
  return Math.min(Math.floor(requested), ceiling)
}

function resolveSize(opts: TerminalCastStartOptions): {
  size: TerminalCastSize
  source: TerminalRecordingSizeSource
} {
  if (opts.engineSize && opts.engineSize.cols > 0 && opts.engineSize.rows > 0) {
    return { size: { ...opts.engineSize }, source: 'engine' }
  }
  if (opts.requestedSize && opts.requestedSize.cols > 0 && opts.requestedSize.rows > 0) {
    return { size: { ...opts.requestedSize }, source: 'requested' }
  }
  return {
    size: { cols: TERMINAL_RECORDING_ASSUMED_COLS, rows: TERMINAL_RECORDING_ASSUMED_ROWS },
    source: 'assumed'
  }
}

function toCapture(active: TerminalCastCapture): TerminalCastCapture {
  return { ...active, caps: { ...active.caps } }
}

export class TerminalCastRecorderLedger {
  private readonly active = new Map<string, ActiveRecording>()
  /** Finished captures by pty, so a `stop` after a cap still names what ended
   *  the recording, and post-cap output has somewhere to be counted. */
  private readonly finished = new Map<string, TerminalCastCapture>()
  private sink: TerminalCastSink | null = null
  private sequence = 0

  constructor(private readonly retention = TERMINAL_RECORDING_CAPTURE_RETENTION) {}

  setSink(sink: TerminalCastSink | null): void {
    this.sink = sink
  }

  /**
   * Close any capture that has outlived its duration cap.
   *
   * Why this exists separately from `ingest`: the cap was only ever evaluated
   * when a chunk arrived, so a pane that went quiet held its capture open
   * forever — reported as still recording, with no file written. The cap bounds
   * wall-clock, so it has to be checked by someone who is not the byte stream.
   * Callers run it before reporting, which is when the staleness is observable.
   */
  sweep(now: number): void {
    const expired: ActiveRecording[] = []
    for (const recording of this.active.values()) {
      if (now - recording.startedAt >= recording.caps.maxDurationMs) {
        expired.push(recording)
      }
    }
    // Collected first: close() deletes from `this.active`.
    for (const recording of expired) {
      this.close(recording, 'duration-cap', recording.startedAt + recording.caps.maxDurationMs)
    }
  }

  isRecording(ptyId: string): boolean {
    return this.active.has(ptyId)
  }

  /** The pane's active capture, or its most recent finished one. */
  captureFor(ptyId: string): TerminalCastCapture | null {
    const recording = this.active.get(ptyId) ?? this.finished.get(ptyId)
    return recording ? toCapture(recording) : null
  }

  /** Active first, then finished, newest start first. */
  captures(): TerminalCastCapture[] {
    return [...this.active.values(), ...this.finished.values()]
      .map(toCapture)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Null when this pane is already recording — one capture per pane, so a
   *  second `start` cannot silently orphan the first one's bytes. */
  start(ptyId: string, at: number, opts: TerminalCastStartOptions): TerminalCastCapture | null {
    if (this.active.has(ptyId)) {
      return null
    }
    const { size, source } = resolveSize(opts)
    this.sequence += 1
    const recording: ActiveRecording = {
      id: `rec_${at.toString(36)}_${this.sequence.toString(36)}`,
      ptyId,
      handle: opts.handle,
      startedAt: at,
      endedAt: null,
      cols: size.cols,
      rows: size.rows,
      sizeSource: source,
      bytesCaptured: 0,
      eventsCaptured: 0,
      bytesDroppedAfterCap: 0,
      stopReason: null,
      caps: {
        maxDurationMs: clamp(
          opts.maxDurationMs,
          TERMINAL_RECORDING_DEFAULT_MAX_DURATION_MS,
          TERMINAL_RECORDING_MAX_DURATION_MS
        ),
        maxBytes: clamp(
          opts.maxBytes,
          TERMINAL_RECORDING_DEFAULT_MAX_BYTES,
          TERMINAL_RECORDING_MAX_BYTES
        ),
        maxEvents: clamp(
          opts.maxEvents,
          TERMINAL_RECORDING_DEFAULT_MAX_EVENTS,
          TERMINAL_RECORDING_MAX_EVENTS
        )
      },
      title: opts.title ?? null,
      events: [],
      lastSize: size
    }
    // A new recording supersedes the pane's previous one for reporting; the old
    // cast is already written and still listed by id from the store.
    this.finished.delete(ptyId)
    this.active.set(ptyId, recording)
    return toCapture(recording)
  }

  /**
   * Feed one raw PTY chunk. `size` is the engine's applied size at this instant
   * when the pane has a live emulator — the only resize signal this runtime
   * has, since there is no resize hook to subscribe to.
   */
  ingest(ptyId: string, data: string, at: number, size?: TerminalCastSize | null): void {
    const recording = this.active.get(ptyId)
    if (!recording) {
      this.noteDroppedAfterCap(ptyId, Buffer.byteLength(data, 'utf8'))
      return
    }
    if (at - recording.startedAt >= recording.caps.maxDurationMs) {
      this.close(recording, 'duration-cap', at)
      this.noteDroppedAfterCap(ptyId, Buffer.byteLength(data, 'utf8'))
      return
    }
    if (data.length === 0) {
      return
    }
    const time = asciicastTimeSeconds(at - recording.startedAt)
    if (size && (size.cols !== recording.lastSize.cols || size.rows !== recording.lastSize.rows)) {
      recording.lastSize = { cols: size.cols, rows: size.rows }
      recording.events.push({ time, code: 'r', data: asciicastResizeData(size.cols, size.rows) })
      recording.eventsCaptured += 1
    }
    recording.events.push({ time, code: 'o', data })
    // Byte length, not string length: `data` is a JS string, so `.length` counts
    // UTF-16 units and undercounts every non-BMP and most non-ASCII output —
    // which would let a capture sail past its byte cap.
    recording.bytesCaptured += Buffer.byteLength(data, 'utf8')
    recording.eventsCaptured += 1
    if (recording.bytesCaptured >= recording.caps.maxBytes) {
      this.close(recording, 'byte-cap', at)
      return
    }
    if (recording.eventsCaptured >= recording.caps.maxEvents) {
      this.close(recording, 'event-cap', at)
    }
  }

  /**
   * Close the pane's recording. Returns the capture even when a cap had already
   * closed it — asking to stop something that stopped itself must hand back the
   * recording with the cap named, not "there is nothing here".
   */
  stop(ptyId: string, at: number, reason: TerminalRecordingStopReason): TerminalCastCapture | null {
    const recording = this.active.get(ptyId)
    if (!recording) {
      return this.captureFor(ptyId)
    }
    this.close(recording, reason, at)
    return this.finished.get(ptyId) ?? null
  }

  /** PTY teardown: a pane that exits mid-recording produced a recording, so the
   *  cast still reaches the sink. */
  dropPty(ptyId: string, at: number, reason: TerminalRecordingStopReason = 'pty-dropped'): void {
    const recording = this.active.get(ptyId)
    if (recording) {
      this.close(recording, reason, at)
    }
  }

  private noteDroppedAfterCap(ptyId: string, bytes: number): void {
    const closed = this.finished.get(ptyId)
    if (closed?.stopReason?.endsWith('-cap') === true) {
      closed.bytesDroppedAfterCap += bytes
    }
  }

  private close(recording: ActiveRecording, reason: TerminalRecordingStopReason, at: number): void {
    recording.stopReason = reason
    recording.endedAt = at
    this.active.delete(recording.ptyId)
    this.finished.delete(recording.ptyId)
    this.finished.set(recording.ptyId, recording)
    for (const [oldest] of this.finished) {
      if (this.finished.size <= this.retention) {
        break
      }
      this.finished.delete(oldest)
    }
    const cast = this.encode(recording)
    this.sink?.({ capture: toCapture(recording), cast })
    // Why the buffer is dropped here: the cast is already encoded, and a retained
    // capture only needs its metadata. Holding every event forever meant `retention`
    // finished captures pinned their full byte caps in memory for the process's life.
    recording.events = []
  }

  private encode(recording: ActiveRecording): string {
    const endedAt = recording.endedAt ?? recording.startedAt
    const header: AsciicastHeader = {
      version: ASCIICAST_VERSION,
      width: recording.cols,
      height: recording.rows,
      timestamp: Math.floor(recording.startedAt / 1000),
      duration: asciicastTimeSeconds(endedAt - recording.startedAt),
      ...(recording.title ? { title: recording.title } : {})
    }
    return encodeAsciicast(header, recording.events)
  }
}

// Module state, matching terminal-command-blocks.ts: the ingest site in
// onPtyData and the RPC read path must share one ledger without threading it
// through the service constructor.
let ledger = new TerminalCastRecorderLedger()

export function terminalCastRecorder(): TerminalCastRecorderLedger {
  return ledger
}

export function resetTerminalCastRecorderForTest(): void {
  ledger = new TerminalCastRecorderLedger()
}
