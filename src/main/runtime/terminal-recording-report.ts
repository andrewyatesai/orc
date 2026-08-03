/**
 * Assembly and refusals for `terminal.record`: capture facts + the written file
 * -> the wire result, and every "no" as a named cause with a sentence.
 *
 * The rule this module exists to enforce is the one §7 of the visibility map
 * turns on: a recording that captured nothing and a pane this runtime cannot
 * tap produce the same empty cast, so a driver must never be handed one and
 * left to guess which it got.
 *
 * That difference cannot always be decided before a capture opens. A pane whose
 * bytes have been seen here is provably tappable, but a pane that has simply
 * been QUIET is indistinguishable from a foreign one — a PTY record alone does
 * not prove ingest, because restore and controller discovery both mint records
 * for panes this process never attached to. Refusing on that evidence would
 * reject freshly started local panes; accepting it silently is the blind spot.
 * So the tap is three-valued: refuse what is provably untappable, and let a
 * quiet pane record while marking it `tapProven: false`, which surfaces as a
 * blind spot on start and as an explicit verdict on a zero-event stop.
 *
 * Pure module: pane facts are injected, so every refusal is testable without a
 * runtime, a PTY or an addon.
 */
import {
  TERMINAL_CAST_UNPROVEN_TAP_BLIND_SPOT,
  TERMINAL_RECORDING_BLIND_SPOTS,
  TERMINAL_RECORDING_SCHEMA_VERSION,
  terminalRecordingPlayback,
  type TerminalRecordingListResult,
  type TerminalRecordingStartResult,
  type TerminalRecordingStopResult,
  type TerminalRecordingSummary,
  type TerminalRecordingUnavailableReason
} from '../../shared/terminal-recording-protocol'
import type { TerminalCastCapture } from './terminal-cast-recorder'
import {
  TERMINAL_RECORDING_FILE_LIMIT,
  TERMINAL_RECORDING_RETENTION_MS,
  type TerminalRecordingFile
} from './terminal-recording-store'

/** What the runtime knows about a pane before deciding it can be recorded. */
export type TerminalRecordingPaneFacts = {
  /** The handle resolved to a pane this runtime hosts. */
  paneExists: boolean
  ptyId: string | null
  /** Bytes for this PTY have actually passed through this process — an output
   *  sequence was counted, or a live headless engine is fed here. Set only by
   *  the ingest path, so it proves the tap; false only means "not yet proven",
   *  since a quiet local pane has produced nothing to observe. */
  bytesObservedHere: boolean
  /** A PTY record exists here that this process did not learn from ingest.
   *  Restore and controller discovery both mint these for foreign panes. */
  paneRecordIsLocal: boolean
}

export type TerminalRecordingTap =
  | { ok: true; ptyId: string; tapProven: boolean }
  | { ok: false; reason: TerminalRecordingUnavailableReason; detail: string }

export function resolveRecordingTap(facts: TerminalRecordingPaneFacts): TerminalRecordingTap {
  if (!facts.paneExists) {
    return {
      ok: false,
      reason: 'pane-not-hosted-here',
      detail:
        'This runtime does not host that terminal handle. A pane served by a remote runtime is recorded by that runtime — its PTY bytes never reach this process, so a capture opened here would produce an empty cast rather than a recording.'
    }
  }
  if (!facts.ptyId) {
    return {
      ok: false,
      reason: 'no-pty',
      detail:
        'This pane has not spawned a PTY yet, so there is no byte stream to tap. Start the terminal first, then record.'
    }
  }
  if (!facts.bytesObservedHere && !facts.paneRecordIsLocal) {
    return {
      ok: false,
      reason: 'bytes-not-local',
      detail:
        'This runtime holds no local ingest state for that PTY, so its output does not pass through this process (a remote-runtime or foreign-daemon pane). Recording here would capture nothing; record it from the runtime that owns the PTY.'
    }
  }
  // A local record with no bytes seen yet is a quiet pane OR a pane whose
  // stream lands elsewhere. Both record; only the caller can tell them apart,
  // and only if we say which one it might be.
  return { ok: true, ptyId: facts.ptyId, tapProven: facts.bytesObservedHere }
}

export function toRecordingSummary(
  capture: TerminalCastCapture,
  file: TerminalRecordingFile | null
): TerminalRecordingSummary {
  const endedAt = capture.endedAt
  return {
    id: capture.id,
    handle: capture.handle,
    state: capture.stopReason === null ? 'recording' : 'finalized',
    path: file?.path ?? null,
    startedAt: capture.startedAt,
    endedAt,
    durationMs: Math.max(0, (endedAt ?? capture.startedAt) - capture.startedAt),
    cols: capture.cols,
    rows: capture.rows,
    sizeSource: capture.sizeSource,
    bytesCaptured: capture.bytesCaptured,
    eventsCaptured: capture.eventsCaptured,
    bytesDroppedAfterCap: capture.bytesDroppedAfterCap,
    stopReason: capture.stopReason,
    caps: capture.caps,
    fileBytes: file?.fileBytes ?? null,
    writeError: file?.error ?? null
  }
}

export function refuseRecordingStart(
  reason: TerminalRecordingUnavailableReason,
  detail: string,
  recording: TerminalRecordingSummary | null = null
): TerminalRecordingStartResult {
  return {
    schema: TERMINAL_RECORDING_SCHEMA_VERSION,
    started: false,
    unavailable: reason,
    detail,
    recording,
    blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
  }
}

export function startedRecording(
  recording: TerminalRecordingSummary,
  tapProven = true
): TerminalRecordingStartResult {
  return {
    schema: TERMINAL_RECORDING_SCHEMA_VERSION,
    started: true,
    detail: tapProven
      ? null
      : 'Recording started, but no output from this PTY has passed through this runtime yet, so the tap is unverified — see the tap-not-proven blind spot.',
    recording,
    blindSpots: tapProven
      ? TERMINAL_RECORDING_BLIND_SPOTS
      : [...TERMINAL_RECORDING_BLIND_SPOTS, TERMINAL_CAST_UNPROVEN_TAP_BLIND_SPOT]
  }
}

export function refuseRecordingStop(
  reason: TerminalRecordingUnavailableReason,
  detail: string
): TerminalRecordingStopResult {
  return {
    schema: TERMINAL_RECORDING_SCHEMA_VERSION,
    stopped: false,
    unavailable: reason,
    detail,
    recording: null,
    playback: null,
    blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
  }
}

/** A cast that failed to write is still described: the capture happened, and
 *  hiding the loss behind a bare success is the failure this contract forbids. */
export function stoppedRecording(recording: TerminalRecordingSummary): TerminalRecordingStopResult {
  if (recording.path === null) {
    return {
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      stopped: true,
      unavailable: recording.writeError === null ? 'store-unavailable' : 'write-failed',
      detail:
        recording.writeError === null
          ? 'The capture finished but no file was written: the recording store could not be opened.'
          : `The capture finished but the cast could not be written: ${recording.writeError}`,
      recording,
      playback: null,
      blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
    }
  }
  // The one ambiguity a cast cannot resolve on its own: an empty file means
  // either the pane was silent or this runtime never carried its bytes. Say so
  // at the only moment it is knowable, rather than shipping a blank recording
  // that reads as a fact.
  if (recording.eventsCaptured === 0) {
    return {
      schema: TERMINAL_RECORDING_SCHEMA_VERSION,
      stopped: true,
      detail:
        'This capture recorded zero events. Either the pane produced no output for the whole window, or its bytes are carried by another runtime and never reached this one. The cast was written and is valid; it is empty.',
      recording,
      playback: terminalRecordingPlayback(recording.path),
      blindSpots: [...TERMINAL_RECORDING_BLIND_SPOTS, TERMINAL_CAST_UNPROVEN_TAP_BLIND_SPOT]
    }
  }
  return {
    schema: TERMINAL_RECORDING_SCHEMA_VERSION,
    stopped: true,
    detail: null,
    recording,
    playback: terminalRecordingPlayback(recording.path),
    blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
  }
}

export function buildRecordingList(args: {
  recordings: TerminalRecordingSummary[]
  directory: string | null
  directoryError: string | null
  filesFromOtherRuns: number
}): TerminalRecordingListResult {
  return {
    schema: TERMINAL_RECORDING_SCHEMA_VERSION,
    available: args.directory !== null,
    ...(args.directory === null ? { unavailable: 'store-unavailable' as const } : {}),
    detail:
      args.directory === null
        ? `The recording store could not be opened${args.directoryError ? `: ${args.directoryError}` : ''}. Recordings this runtime captured are still listed, but no path can be given for them.`
        : null,
    recordings: args.recordings,
    directory: args.directory,
    pathsAreOnRuntimeHost: true,
    retentionMs: TERMINAL_RECORDING_RETENTION_MS,
    retainedFileLimit: TERMINAL_RECORDING_FILE_LIMIT,
    filesFromOtherRuns: args.filesFromOtherRuns,
    blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
  }
}
