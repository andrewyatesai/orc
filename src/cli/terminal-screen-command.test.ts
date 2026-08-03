// The CLI face of terminal.screen: the documented flags parse, an undefined
// --detail is refused rather than quietly degraded, and the plain-text render
// says which row the cursor is on and what is styled — the two things a colour
// -blind view must still convey.
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from './specs'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from './args'
import { TERMINAL_CONTEXT_HANDLERS } from './handlers/terminal-context'
import { formatTerminalScreen } from './terminal-screen-format'
import type { TerminalScreenResult } from '../shared/terminal-screen-protocol'

const RESULT: TerminalScreenResult = {
  schema: 1,
  available: true,
  detail: 'compact',
  rows: [
    { row: 0, runs: [{ col: 0, cols: 5, text: 'plain' }] },
    { row: 1, runs: [{ col: 0, cols: 6, text: 'picked', attrs: ['inverse'], bg: '#ffffff' }] }
  ],
  gridRows: 24,
  gridCols: 80,
  firstRow: 0,
  rowsTruncated: false,
  runsReturned: 2,
  maxRuns: 4000,
  trailingBlanksTrimmed: true,
  defaultFg: '#c0c0c0',
  defaultBg: '#000000',
  cursor: { row: 1, col: 6, visible: true, style: 'steady-bar' },
  modes: {
    alternateScreen: true,
    applicationCursor: true,
    bracketedPaste: false,
    mouseTracking: 'none',
    sgrMouse: false,
    sgrPixels: false,
    mouseEncoding: 'x10',
    kittyKeyboardFlags: 0,
    reverseVideo: false
  },
  contentSeq: 12,
  blindSpots: []
}

function parse(argv: string[]) {
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

describe('orca terminal screen', () => {
  it('accepts every documented flag', () => {
    const parsed = parse([
      'terminal',
      'screen',
      '--terminal',
      'term_abc',
      '--detail',
      'full',
      '--from-row',
      '20',
      '--rows',
      '10',
      '--max-runs',
      '500',
      '--json'
    ])
    expect(parsed.commandPath).toEqual(['terminal', 'screen'])
    expect(parsed.flags.get('detail')).toBe('full')
    expect(parsed.flags.get('from-row')).toBe('20')
    expect(parsed.flags.get('rows')).toBe('10')
    expect(parsed.flags.get('max-runs')).toBe('500')
  })

  it('rejects a flag the spec does not document', () => {
    expect(() => parse(['terminal', 'screen', '--nope'])).toThrow(/Unknown flag/)
  })

  it('refuses an unrecognised --detail instead of silently sending compact', async () => {
    const call = vi.fn()
    const flags = parse(['terminal', 'screen', '--detail', 'lossless']).flags
    await expect(
      TERMINAL_CONTEXT_HANDLERS['terminal screen']({
        flags,
        client: { call } as never,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toThrow(/--detail must be compact or full/)
    expect(call).not.toHaveBeenCalled()
  })

  it('forwards the window and prints the formatted frame', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, result: { screen: RESULT } })
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const flags = parse([
      'terminal',
      'screen',
      '--terminal',
      't1',
      '--detail',
      'full',
      '--from-row',
      '4'
    ]).flags
    await TERMINAL_CONTEXT_HANDLERS['terminal screen']({
      flags,
      client: { call } as never,
      cwd: '/tmp',
      json: false
    } as never)
    log.mockRestore()
    expect(call).toHaveBeenCalledWith('terminal.screen', {
      terminal: 't1',
      detail: 'full',
      fromRow: 4,
      rowCount: undefined,
      maxRuns: undefined
    })
    expect(printed.join('\n')).toContain('Screen 80x24')
  })
})

describe('formatTerminalScreen — what a colour-blind view must still say', () => {
  it('marks the cursor row and spells out the styled runs', () => {
    const text = formatTerminalScreen(RESULT)
    expect(text).toContain('Cursor: row 1 col 6, visible, steady-bar')
    // The keystone question — which row is selected — must be answerable from
    // plain text, because the terminal printing this renders no SGR.
    expect(text).toContain('>  1 | picked')
    expect(text).toContain('inverse')
    expect(text).toContain('bg #ffffff')
  })

  it('names the input modes that change what a keystroke means', () => {
    const text = formatTerminalScreen(RESULT)
    expect(text).toContain('application-cursor (arrows are ESC O A)')
    expect(text).toContain('alt-screen')
  })

  it('says a frame was cut rather than showing it as the whole screen', () => {
    const text = formatTerminalScreen({ ...RESULT, rowsTruncated: true, firstRow: 4 })
    expect(text).toContain('Rows 4-5 of 24 — the rest were not served')
  })

  it('calls a complete frame complete, and never infers truncation from a short list', () => {
    // A genuinely blank grid: zero rows, nothing withheld. Reading "the rest
    // were not served" here would invent a blind spot that does not exist.
    const text = formatTerminalScreen({ ...RESULT, rows: [], runsReturned: 0 })
    expect(text).toContain('All 24 rows of the visible grid.')
    expect(text).not.toContain('not served')
  })

  it('refuses to describe a window it served no rows for as a row range', () => {
    const text = formatTerminalScreen({
      ...RESULT,
      rows: [],
      runsReturned: 0,
      rowsTruncated: true,
      firstRow: 20
    })
    expect(text).toContain('NO rows were served')
    expect(text).toContain('says nothing about what is on the screen')
  })

  it('distinguishes "cannot see" from "blank" in the unavailable render', () => {
    const text = formatTerminalScreen({
      ...RESULT,
      available: false,
      unavailable: 'addon-too-old',
      rows: []
    })
    expect(text).toContain('addon-too-old')
    expect(text).toContain('cannot read a styled grid at all')
  })
})
