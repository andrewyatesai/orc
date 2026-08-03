/**
 * Wire types for `terminal.record` — a timed, replayable recording of a pane in
 * asciicast v2 (docs/reference/alab-agent-visibility.md §7).
 *
 * What this is, stated once so no caller has to infer it: Orca does not tap a
 * GPU present path — that machinery belongs to aterm-gui's window and swapchain,
 * which Orca does not link (§7.1). What Orca has is every byte of every local,
 * daemon and SSH pane at `onPtyData`, and aterm's own INTROSPECTION.md says a
 * cast "faithfully reproduces the terminal CONTENT (text, styling, cursor)" and
 * misses only host-rendered overlays. For a coding agent's TUI that IS the
 * recording, and `agg`/`ffmpeg` turn it into a video a human can watch.
 *
 * So the honesty contract here has a specific shape. A recording is
 * CONTENT-faithful, not PIXEL-faithful, and every result says so rather than
 * letting "video" imply a screen capture. And a pane whose bytes never reach
 * this runtime is refused BY NAME — never handed a recording that would be
 * silently, plausibly empty.
 */
import type { TerminalContextBlindSpot } from './terminal-context-protocol'

export const TERMINAL_RECORDING_SCHEMA_VERSION = 1

/** Why a recording could not start, stop, or be listed. Each value is a
 *  different cause with a different fix — which is why they are named instead
 *  of collapsed into one falsy result. */
export type TerminalRecordingUnavailableReason =
  /** The handle is not one this runtime hosts. A pane served by a REMOTE
   *  runtime is recorded by that runtime, not this one. */
  | 'pane-not-hosted-here'
  /** The pane exists but has not spawned a PTY yet — nothing to tap. */
  | 'no-pty'
  /** The pane exists and this runtime does not ingest its bytes, so a tap here
   *  would produce an empty cast that looks like a silent terminal. */
  | 'bytes-not-local'
  /** One recording per pane; the active one is named in the result. */
  | 'already-recording'
  /** Stop was asked for a pane with no active recording. */
  | 'not-recording'
  /** The cast was captured but could not be written to the recording store. */
  | 'write-failed'
  /** The recording directory could not be created or read. */
  | 'store-unavailable'

/** What ended the capture. A cap firing is reported here rather than silently
 *  truncating: the difference between "the agent stopped printing" and "I hit
 *  my byte ceiling" is the whole reason this field exists. */
export type TerminalRecordingStopReason =
  | 'requested'
  | 'duration-cap'
  | 'byte-cap'
  | 'event-cap'
  | 'pty-exit'
  | 'pty-dropped'

/** Where the cast's declared width/height came from. `assumed` means nobody
 *  could tell us, so playback geometry is a guess and says so. */
export type TerminalRecordingSizeSource = 'engine' | 'requested' | 'assumed'

/** The bounds actually applied, after clamping. Reported on every recording so
 *  a caller that asked for more learns it was clamped instead of inferring it
 *  from a short result. */
export type TerminalRecordingCaps = {
  maxDurationMs: number
  maxBytes: number
  maxEvents: number
}

export type TerminalRecordingState = 'recording' | 'finalized'

export type TerminalRecordingSummary = {
  /** Stable id, unique per runtime; the join key for `stop` and `list`. */
  id: string
  handle: string
  state: TerminalRecordingState
  /** Absolute path of the `.cast` file ON THE RUNTIME HOST. Null while the
   *  recording is still open — nothing is written until it finalizes. */
  path: string | null
  startedAt: number
  endedAt: number | null
  /** Wall-clock span the cast covers, in ms. */
  durationMs: number
  cols: number
  rows: number
  sizeSource: TerminalRecordingSizeSource
  /** PTY bytes admitted into the cast (before JSON escaping). */
  bytesCaptured: number
  /** Cast events written, output and resize together. */
  eventsCaptured: number
  /** Bytes the caps refused AFTER the recording was already closed by one of
   *  them. Non-zero proves output continued past the end of the recording — the
   *  fact that keeps a capped cast from reading as a complete one. */
  bytesDroppedAfterCap: number
  /** Null while recording. */
  stopReason: TerminalRecordingStopReason | null
  caps: TerminalRecordingCaps
  /** Size of the written file, null when not written (yet or at all). */
  fileBytes: number | null
  /** Non-null only when the cast was captured and the write failed — the
   *  capture is still described, so the loss is visible rather than silent. */
  writeError: string | null
}

/** The exact commands that turn a finished cast into something watchable. The
 *  goal is video the user can watch, so the result carries the command line
 *  rather than making the caller remember the toolchain. */
export type TerminalRecordingPlayback = {
  /** Replay in a terminal, original timing. */
  play: string
  /** asciicast -> animated GIF. */
  gif: string
  /** GIF -> mp4, even dimensions and faststart so players accept it. */
  mp4: string
}

export function terminalRecordingPlayback(castPath: string): TerminalRecordingPlayback {
  const stem = castPath.replace(/\.cast$/, '')
  return {
    play: `asciinema play ${castPath}`,
    gif: `agg ${castPath} ${stem}.gif`,
    mp4: `ffmpeg -y -i ${stem}.gif -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" ${stem}.mp4`
  }
}

type TerminalRecordingOutcome = {
  schema: number
  /** Named cause; absent only on success. */
  unavailable?: TerminalRecordingUnavailableReason
  /** One sentence naming the cause. Null only on success. */
  detail: string | null
  recording: TerminalRecordingSummary | null
  blindSpots: TerminalContextBlindSpot[]
}

export type TerminalRecordingStartResult = TerminalRecordingOutcome & { started: boolean }

export type TerminalRecordingStopResult = TerminalRecordingOutcome & {
  stopped: boolean
  /** Null when nothing was written. */
  playback: TerminalRecordingPlayback | null
}

export type TerminalRecordingListResult = {
  schema: number
  available: boolean
  unavailable?: TerminalRecordingUnavailableReason
  detail: string | null
  /** Newest first: active recordings, then finalized ones still retained. */
  recordings: TerminalRecordingSummary[]
  /** The store directory on the runtime host, null when it could not be opened. */
  directory: string | null
  /** Paths in this result are on the host that RUNS the runtime. A CLI talking
   *  to a remote runtime cannot open them locally. */
  pathsAreOnRuntimeHost: true
  /** Files older than this, or beyond the count, are deleted by the store. */
  retentionMs: number
  retainedFileLimit: number
  /** Casts sitting in the store that this runtime did not write — earlier runs.
   *  A count, not entries: their capture facts died with the process that made
   *  them, and inventing metadata for them would be worse than naming the gap. */
  filesFromOtherRuns: number
  blindSpots: TerminalContextBlindSpot[]
}

/** The central caveat. A cast is the byte stream, replayed with its timing —
 *  everything the renderer draws ON TOP of it is absent by construction. */
export const TERMINAL_CAST_PIXEL_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'video',
  reason: 'cast-is-content-not-pixels',
  detail:
    'This is a byte-stream recording replayed with its original timing: content-faithful (text, styling, cursor), not pixel-faithful. Host-rendered overlays — selection, find-bar highlight, tab chrome, IME candidate windows — and any true present-destination effect are drawn downstream of the PTY and are absent. It is not a screen capture; aterm-gui owns the only real swapchain tap.'
}

/** The image nuance, which is narrower and stranger than "no images": the
 *  escape sequences ARE in the file; the tools that render a cast ignore them. */
export const TERMINAL_CAST_INLINE_IMAGE_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'graphics',
  reason: 'inline-image-sequences-not-replayed',
  detail:
    'Inline-image escape sequences (sixel, OSC-1337, Kitty) are captured verbatim in the cast, but asciinema and agg do not draw them, so they will be missing from any GIF or mp4 rendered from this file. Read terminal.images for the actual payloads.'
}

/** Resizes are inferred from the engine's applied size at the next output
 *  chunk, because this runtime has no resize hook to subscribe to. */
export const TERMINAL_CAST_RESIZE_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'video',
  reason: 'resize-observed-only-with-output',
  detail:
    'Resize events are detected by comparing the engine size at each captured chunk, so a resize that produces no further output is not in the cast, and a pane with no live headless engine contributes no resize events at all.'
}

/** Raised only when a capture opens on a pane whose byte stream this process
 *  has not yet been seen to carry. The recording is real; what it proves is
 *  narrower, and an empty result cannot be read as "the pane was silent". */
export const TERMINAL_CAST_UNPROVEN_TAP_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'video',
  reason: 'tap-not-proven',
  detail:
    'No output from this PTY has passed through this runtime yet, so the tap is unverified. A quiet pane and a pane whose bytes are carried by another runtime look identical from here. If this recording ends with zero events, treat that as "could not observe", not as "nothing happened".'
}

export const TERMINAL_RECORDING_BLIND_SPOTS: TerminalContextBlindSpot[] = [
  TERMINAL_CAST_PIXEL_BLIND_SPOT,
  TERMINAL_CAST_INLINE_IMAGE_BLIND_SPOT,
  TERMINAL_CAST_RESIZE_BLIND_SPOT
]
