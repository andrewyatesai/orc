/**
 * Printer for `orca terminal await` — §5.3's outcome
 * (docs/reference/alab-auto-mode-design.md).
 *
 * The rule this file exists to keep: **every outcome prints its cursors.** The
 * RPC transport is one-shot, so each return destroys the watch; a caller that
 * does not re-arm from these cursors loses whatever happened on the other panes
 * between the return and the next call. Making them easy to miss in the human
 * output would make that loss the default.
 *
 * `gap` is likewise never smoothed over. It says the position the caller asked
 * for could not be honored, and the returned cursor is a real one to resume
 * from — printing it as a normal event would hide a hole in the history.
 *
 * Typed structurally rather than imported from the runtime: the CLI builds
 * against `src/shared` only, and its job is to print what the server said.
 */

import { encodeTerminalEventCursor } from '../shared/terminal-event-cursor-token'

export type CliTerminalAwaitCursor = {
  terminal: string
  cursor: { runtimeId: string; ptyIncarnationId: string; eventSeq: number }
}

export type CliTerminalAwaitOutcome = {
  outcome: 'event' | 'gap' | 'exit' | 'timeout' | 'unsupported'
  terminal?: string
  reason?: string
  kinds?: string[]
  event?: { kind: string; eventSeq: number; at: number }
  cursors: CliTerminalAwaitCursor[]
}

function cursorLines(cursors: CliTerminalAwaitCursor[]): string[] {
  if (cursors.length === 0) {
    return []
  }
  return [
    'Resume with:',
    ...cursors.map(
      (entry) =>
        `  --terminal ${entry.terminal} --cursor ${encodeTerminalEventCursor(entry.cursor)}`
    )
  ]
}

function headline(result: CliTerminalAwaitOutcome): string {
  switch (result.outcome) {
    case 'event':
      return `${result.terminal}: ${result.event?.kind ?? 'event'}`
    case 'gap':
      return `${result.terminal}: gap (${result.reason ?? 'unknown'}) — history was lost, resume from the cursor below`
    case 'exit':
      return `${result.terminal}: exited`
    case 'timeout':
      return 'Timed out with no event'
    case 'unsupported':
      return `Cannot be produced by this runtime: ${(result.kinds ?? []).join(', ')}${
        result.reason ? ` (${result.reason})` : ''
      }`
  }
}

export function formatTerminalAwait(value: { await: CliTerminalAwaitOutcome }): string {
  return [headline(value.await), ...cursorLines(value.await.cursors)].join('\n')
}
