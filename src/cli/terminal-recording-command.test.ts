// The CLI face of terminal.record: the documented flags parse, the caps reach
// the runtime verb by name, and the printed output carries the conversion
// commands a caller needs to actually get a video.
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from './specs'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from './args'
import { TERMINAL_RECORDING_HANDLERS } from './handlers/terminal-recording'
import {
  TERMINAL_RECORDING_BLIND_SPOTS,
  TERMINAL_RECORDING_SCHEMA_VERSION,
  terminalRecordingPlayback,
  type TerminalRecordingStopResult,
  type TerminalRecordingSummary
} from '../shared/terminal-recording-protocol'

const SUMMARY: TerminalRecordingSummary = {
  id: 'rec_1',
  handle: 't1',
  state: 'finalized',
  path: '/tmp/casts/rec_1.cast',
  startedAt: 1_000,
  endedAt: 3_000,
  durationMs: 2_000,
  cols: 80,
  rows: 24,
  sizeSource: 'engine',
  bytesCaptured: 128,
  eventsCaptured: 3,
  bytesDroppedAfterCap: 0,
  stopReason: 'requested',
  caps: { maxDurationMs: 300_000, maxBytes: 8_388_608, maxEvents: 20_000 },
  fileBytes: 200,
  writeError: null
}

const STOP_RESULT: TerminalRecordingStopResult = {
  schema: TERMINAL_RECORDING_SCHEMA_VERSION,
  stopped: true,
  detail: null,
  recording: SUMMARY,
  playback: terminalRecordingPlayback('/tmp/casts/rec_1.cast'),
  blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
}

function parse(argv: string[]) {
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

async function runHandler(
  key: string,
  flags: Map<string, string | boolean>,
  call: ReturnType<typeof vi.fn>
): Promise<string> {
  const printed: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.push(String(line))
  })
  await TERMINAL_RECORDING_HANDLERS[key]({
    flags,
    client: { call } as never,
    cwd: '/tmp',
    json: false
  } as never)
  log.mockRestore()
  return printed.join('\n')
}

describe('orca terminal record-*', () => {
  it('accepts every documented start flag', () => {
    const parsed = parse([
      'terminal',
      'record-start',
      '--terminal',
      'term_abc',
      '--title',
      'demo',
      '--max-duration-ms',
      '60000',
      '--max-bytes',
      '1024',
      '--max-events',
      '50',
      '--cols',
      '132',
      '--rows',
      '43',
      '--json'
    ])
    expect(parsed.commandPath).toEqual(['terminal', 'record-start'])
    expect(parsed.flags.get('max-duration-ms')).toBe('60000')
    expect(parsed.flags.get('cols')).toBe('132')
  })

  it('rejects a flag no record spec documents', () => {
    expect(() => parse(['terminal', 'record-start', '--nope'])).toThrow(/Unknown flag/)
    expect(() => parse(['terminal', 'record-list', '--terminal', 't1'])).toThrow(/Unknown flag/)
  })

  it('forwards the caps to terminal.recordStart', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        recording: {
          schema: TERMINAL_RECORDING_SCHEMA_VERSION,
          started: true,
          detail: null,
          recording: { ...SUMMARY, state: 'recording', stopReason: null },
          blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
        }
      }
    })
    const flags = parse([
      'terminal',
      'record-start',
      '--terminal',
      't1',
      '--max-bytes',
      '1024',
      '--title',
      'demo'
    ]).flags
    const printed = await runHandler('terminal record-start', flags, call)
    expect(call).toHaveBeenCalledWith('terminal.recordStart', {
      terminal: 't1',
      title: 'demo',
      cols: undefined,
      rows: undefined,
      maxDurationMs: undefined,
      maxBytes: 1024,
      maxEvents: undefined
    })
    expect(printed).toContain('Recording rec_1 started')
  })

  it('prints the agg and ffmpeg commands on stop', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, result: { recording: STOP_RESULT } })
    const flags = parse(['terminal', 'record-stop', '--terminal', 't1']).flags
    const printed = await runHandler('terminal record-stop', flags, call)
    expect(call).toHaveBeenCalledWith('terminal.recordStop', { terminal: 't1' })
    expect(printed).toContain('agg /tmp/casts/rec_1.cast /tmp/casts/rec_1.gif')
    expect(printed).toContain('ffmpeg -y -i /tmp/casts/rec_1.gif')
  })

  it('lists with no terminal handle at all', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        recordings: {
          schema: TERMINAL_RECORDING_SCHEMA_VERSION,
          available: true,
          detail: null,
          recordings: [],
          directory: '/tmp/casts',
          pathsAreOnRuntimeHost: true,
          retentionMs: 86_400_000,
          retainedFileLimit: 32,
          filesFromOtherRuns: 0,
          blindSpots: TERMINAL_RECORDING_BLIND_SPOTS
        }
      }
    })
    const printed = await runHandler(
      'terminal record-list',
      parse(['terminal', 'record-list']).flags,
      call
    )
    expect(call).toHaveBeenCalledWith('terminal.recordList', {})
    expect(printed).toContain('/tmp/casts')
  })
})
