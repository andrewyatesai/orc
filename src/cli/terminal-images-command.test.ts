// The CLI face of terminal.images: the documented flags parse, the boolean
// --bytes is a boolean (not a value flag that swallows the next token), and the
// handler forwards the byte request to the runtime verb.
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from './specs'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from './args'
import { TERMINAL_CONTEXT_HANDLERS } from './handlers/terminal-context'
import type { TerminalInlineImagesResult } from '../shared/terminal-inline-images-protocol'

const RESULT: TerminalInlineImagesResult = {
  schema: 1,
  available: true,
  images: [],
  totalPlacements: 0,
  gridRows: 24,
  gridCols: 80,
  unscannableHistoryRows: 0,
  bytesRequested: true,
  maxBytesPerImage: 4096,
  maxTotalBytes: 8192,
  bytesReturned: 0,
  blindSpots: []
}

function parse(argv: string[]) {
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

describe('orca terminal images', () => {
  it('accepts every documented flag', () => {
    const parsed = parse([
      'terminal',
      'images',
      '--terminal',
      'term_abc',
      '--bytes',
      '--max-bytes',
      '4096',
      '--max-total-bytes',
      '8192',
      '--json'
    ])
    expect(parsed.commandPath).toEqual(['terminal', 'images'])
    // Boolean, so it must not consume `--max-bytes` as its value.
    expect(parsed.flags.get('bytes')).toBe(true)
    expect(parsed.flags.get('max-bytes')).toBe('4096')
    expect(parsed.flags.get('max-total-bytes')).toBe('8192')
  })

  it('rejects a flag the spec does not document', () => {
    expect(() => parse(['terminal', 'images', '--nope'])).toThrow(/Unknown flag/)
  })

  it('forwards the byte request and prints the formatted result', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, result: { images: RESULT } })
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const flags = parse([
      'terminal',
      'images',
      '--terminal',
      't1',
      '--bytes',
      '--max-bytes',
      '4096'
    ]).flags
    await TERMINAL_CONTEXT_HANDLERS['terminal images']({
      flags,
      client: { call } as never,
      cwd: '/tmp',
      json: false
    } as never)
    log.mockRestore()
    expect(call).toHaveBeenCalledWith('terminal.images', {
      terminal: 't1',
      includeBytes: true,
      maxBytesPerImage: 4096,
      maxTotalBytes: undefined
    })
    expect(printed.join('\n')).toContain('No inline images on the visible grid')
  })
})
