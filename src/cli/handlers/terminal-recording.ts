/**
 * `orca terminal record-start | record-stop | record-list` — the video face.
 *
 * Its own handler group because recording has a lifecycle the read-only context
 * verbs do not: it starts, it ends (possibly on its own, at a cap), and it
 * leaves a file behind that outlives the call.
 */
import type { CommandHandler } from '../dispatch'
import type {
  TerminalRecordingListResult,
  TerminalRecordingStartResult,
  TerminalRecordingStopResult
} from '../../shared/terminal-recording-protocol'
import {
  formatRecordingList,
  formatRecordingStart,
  formatRecordingStop
} from '../terminal-recording-format'
import { printResult } from '../format'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { getTerminalHandle } from '../selectors'

export const TERMINAL_RECORDING_HANDLERS: Record<string, CommandHandler> = {
  'terminal record-start': async ({ flags, client, cwd, json }) => {
    const title = getOptionalStringFlag(flags, 'title')
    const result = await client.call<{ recording: TerminalRecordingStartResult }>(
      'terminal.recordStart',
      {
        terminal: await getTerminalHandle(flags, cwd, client),
        ...(title !== undefined ? { title } : {}),
        cols: getOptionalPositiveIntegerFlag(flags, 'cols'),
        rows: getOptionalPositiveIntegerFlag(flags, 'rows'),
        maxDurationMs: getOptionalPositiveIntegerFlag(flags, 'max-duration-ms'),
        maxBytes: getOptionalPositiveIntegerFlag(flags, 'max-bytes'),
        maxEvents: getOptionalPositiveIntegerFlag(flags, 'max-events')
      }
    )
    printResult(result, json, (value) => formatRecordingStart(value.recording))
  },
  'terminal record-stop': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ recording: TerminalRecordingStopResult }>(
      'terminal.recordStop',
      { terminal: await getTerminalHandle(flags, cwd, client) }
    )
    printResult(result, json, (value) => formatRecordingStop(value.recording))
  },
  'terminal record-list': async ({ client, json }) => {
    const result = await client.call<{ recordings: TerminalRecordingListResult }>(
      'terminal.recordList',
      {}
    )
    printResult(result, json, (value) => formatRecordingList(value.recordings))
  }
}
