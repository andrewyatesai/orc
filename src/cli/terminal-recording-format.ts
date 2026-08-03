/**
 * Human-readable rendering for `orca terminal record-start|record-stop|record-list`.
 *
 * Two things must survive the trip to plain text or the verb is misleading:
 * WHICH cap ended a recording (a byte-capped cast and a finished one look
 * identical otherwise), and the fact that a cast is content-faithful rather
 * than pixel-faithful. Both are printed unconditionally.
 *
 * The playback commands are printed verbatim so the caller can paste them: the
 * point of the verb is video someone can actually watch.
 */
import type {
  TerminalRecordingListResult,
  TerminalRecordingStartResult,
  TerminalRecordingStopResult,
  TerminalRecordingStopReason,
  TerminalRecordingSummary
} from '../shared/terminal-recording-protocol'

const STOP_REASON_NOTE: Record<TerminalRecordingStopReason, string> = {
  requested: 'stopped on request',
  'duration-cap': 'ENDED BY THE DURATION CAP — the pane kept running past this point',
  'byte-cap': 'ENDED BY THE BYTE CAP — the pane kept printing past this point',
  'event-cap': 'ENDED BY THE EVENT CAP — the pane kept printing past this point',
  'pty-exit': 'ended because the terminal process exited',
  'pty-dropped': 'ended because the pane was torn down'
}

function sizeNote(recording: TerminalRecordingSummary): string {
  switch (recording.sizeSource) {
    case 'engine':
      return `${recording.cols}x${recording.rows} (from the live engine)`
    case 'requested':
      return `${recording.cols}x${recording.rows} (as requested; no live engine to ask)`
    case 'assumed':
      return `${recording.cols}x${recording.rows} (ASSUMED — nothing could report the pane size, so playback geometry is a guess)`
  }
}

function capsNote(recording: TerminalRecordingSummary): string {
  const caps = recording.caps
  return `caps: ${caps.maxDurationMs}ms / ${caps.maxBytes} bytes / ${caps.maxEvents} events`
}

export function formatRecordingSummary(recording: TerminalRecordingSummary): string {
  const lines = [
    `${recording.id}  ${recording.state}  ${recording.handle}  ${sizeNote(recording)}`,
    `    ${recording.bytesCaptured} bytes, ${recording.eventsCaptured} events, ${recording.durationMs}ms  ${capsNote(recording)}`
  ]
  if (recording.stopReason) {
    lines.push(`    ${STOP_REASON_NOTE[recording.stopReason]}`)
  }
  if (recording.bytesDroppedAfterCap > 0) {
    lines.push(
      `    ${recording.bytesDroppedAfterCap} further bytes were printed after the cap and are NOT in this cast`
    )
  }
  if (recording.path) {
    lines.push(`    ${recording.path}  (${recording.fileBytes ?? 0} bytes on the runtime host)`)
  } else if (recording.writeError) {
    lines.push(`    NOT WRITTEN: ${recording.writeError}`)
  }
  return lines.join('\n')
}

const FIDELITY_NOTE =
  'A cast reproduces the terminal CONTENT (text, styling, cursor) with its original timing. It is not a pixel capture: host-drawn overlays and inline images will not appear in a rendered video.'

export function formatRecordingStart(result: TerminalRecordingStartResult): string {
  if (!result.started) {
    const active = result.recording ? `\n${formatRecordingSummary(result.recording)}` : ''
    return `Recording not started: ${result.unavailable ?? 'unknown'} — ${result.detail ?? 'cause not reported'}${active}`
  }
  const recording = result.recording
  if (!recording) {
    return 'Recording started, but the runtime reported no recording — treat this as a bug, not as a recording.'
  }
  return `Recording ${recording.id} started on ${recording.handle}.\n${formatRecordingSummary(recording)}\n${FIDELITY_NOTE}\nStop it with: orca terminal record-stop --terminal ${recording.handle}`
}

export function formatRecordingStop(result: TerminalRecordingStopResult): string {
  if (!result.stopped) {
    return `Recording not stopped: ${result.unavailable ?? 'unknown'} — ${result.detail ?? 'cause not reported'}`
  }
  const recording = result.recording
  if (!recording) {
    return 'Recording stopped, but the runtime reported no recording — treat this as a bug, not as an empty capture.'
  }
  const head = `Recording ${recording.id} stopped.\n${formatRecordingSummary(recording)}\n${FIDELITY_NOTE}`
  if (!result.playback) {
    return `${head}\nNo file to convert: ${result.detail ?? 'the cast was not written'}`
  }
  return [
    head,
    '',
    'Watch it:',
    `  ${result.playback.play}`,
    'Render a GIF:',
    `  ${result.playback.gif}`,
    'Then an mp4:',
    `  ${result.playback.mp4}`
  ].join('\n')
}

export function formatRecordingList(result: TerminalRecordingListResult): string {
  const where = result.directory
    ? `Store: ${result.directory} (on the runtime host, not necessarily this machine)`
    : `Store unavailable: ${result.detail ?? 'the recording directory could not be opened'}`
  const retention = `Retention: files older than ${Math.round(result.retentionMs / 3600000)}h are deleted, and only the newest ${result.retainedFileLimit} are kept.`
  const foreign =
    result.filesFromOtherRuns > 0
      ? `\n${result.filesFromOtherRuns} cast file(s) in the store were written by an earlier run; this runtime holds no capture facts for them.`
      : ''
  if (result.recordings.length === 0) {
    return `No recordings from this runtime.\n${where}\n${retention}${foreign}`
  }
  const body = result.recordings.map(formatRecordingSummary).join('\n')
  return `${result.recordings.length} recording(s) from this runtime.\n${where}\n${retention}${foreign}\n\n${body}`
}
