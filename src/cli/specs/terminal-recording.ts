/**
 * `orca terminal record-*` command specs — the video face.
 *
 * Its own module because the terminal spec family is already at its line
 * budget, and because recording is the one terminal verb group that produces a
 * durable artifact rather than a read.
 */
import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_RECORDING_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['terminal', 'record-start'],
    summary: 'Start recording a terminal to an asciicast v2 file',
    usage:
      'orca terminal record-start [--terminal <handle>] [--title <text>] [--max-duration-ms <ms>] [--max-bytes <n>] [--max-events <n>] [--cols <n>] [--rows <n>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'title',
      'max-duration-ms',
      'max-bytes',
      'max-events',
      'cols',
      'rows'
    ],
    notes: [
      'Records the pane’s byte stream with timings, so it replays as the terminal CONTENT — text, styling, cursor. It is not a screen capture: overlays the app draws on top (selection, find highlight, tab chrome) are not in it.',
      'Inline sixel/OSC-1337/Kitty sequences are captured verbatim, but asciinema and agg do not draw them, so they will be missing from a GIF or mp4 — use terminal images for those payloads.',
      'Bounded by duration, bytes and events; whichever cap fires ends the recording, writes the file, and is named as stopReason. Output after a cap is counted, so a capped cast never looks complete.',
      'One recording per pane. A pane this runtime does not host, or whose bytes it does not ingest (a remote-runtime pane), is refused BY NAME rather than given an empty cast.'
    ],
    examples: [
      'orca terminal record-start --json',
      'orca terminal record-start --terminal term_abc123 --max-duration-ms 60000 --json'
    ]
  },
  {
    path: ['terminal', 'record-stop'],
    summary: 'Stop a terminal recording and write the .cast file',
    usage: 'orca terminal record-stop [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    notes: [
      'Prints the exact agg and ffmpeg commands that turn the cast into a GIF and an mp4.',
      'A recording a cap already ended is returned here too, with the cap named — stop never reports "nothing to stop" for a capture that happened.',
      'The path is on the host running the Orca runtime, which is not the local machine when you are driving a remote runtime.'
    ],
    examples: [
      'orca terminal record-stop --json',
      'orca terminal record-stop --terminal term_abc123'
    ]
  },
  {
    path: ['terminal', 'record-list'],
    summary: 'List terminal recordings and where they are stored',
    usage: 'orca terminal record-list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Shows active and finished recordings, the store directory, and the retention that will delete them.',
      'Casts left by earlier runs are reported as a count, not as entries: their capture facts died with the process that wrote them.'
    ],
    examples: ['orca terminal record-list --json']
  }
]
