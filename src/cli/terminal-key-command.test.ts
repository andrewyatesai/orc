// The CLI face of terminal.key: the documented flags parse, the chord goes to
// the runtime whole (one parser, server-side, so the two faces cannot drift), a
// keystroke that never went out is a non-zero exit, and the plain-text render
// never lets "the terminal took the bytes" read as "the program acted".
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from './specs'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from './args'
import { TERMINAL_HANDLERS } from './handlers/terminal'
import { formatTerminalKey } from './terminal-key-format'
import { TERMINAL_KEY_BLIND_SPOTS, type TerminalKeyResult } from '../shared/terminal-key-protocol'

const SENT: TerminalKeyResult = {
  schema: 1,
  handle: 'term_1',
  ptyId: 'pty_1',
  key: 'r',
  modifiers: ['ctrl'],
  sent: true,
  bytes: '\\x12',
  byteLength: 1,
  events: 'press',
  modes: {
    modeBits: 0b101,
    flags: ['disambiguate-esc-codes', 'application-cursor'],
    source: 'runtime-headless-replay'
  },
  operationId: 'op_1',
  decidedAt: 10,
  blindSpots: [...TERMINAL_KEY_BLIND_SPOTS]
}

function parse(argv: string[]) {
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

async function run(argv: string[], result: TerminalKeyResult) {
  const call = vi.fn().mockResolvedValue({ ok: true, result: { key: result } })
  const printed: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.push(String(line))
  })
  const previousExit = process.exitCode
  process.exitCode = undefined
  await TERMINAL_HANDLERS['terminal key']({
    flags: parse(argv).flags,
    client: { call } as never,
    cwd: '/tmp',
    json: false
  } as never)
  log.mockRestore()
  const exitCode = process.exitCode
  process.exitCode = previousExit
  return { call, printed: printed.join('\n'), exitCode }
}

describe('orca terminal key', () => {
  it('accepts every documented flag', () => {
    const parsed = parse(['terminal', 'key', '--terminal', 'term_abc', '--key', 'ctrl+r', '--json'])
    expect(parsed.commandPath).toEqual(['terminal', 'key'])
    expect(parsed.flags.get('key')).toBe('ctrl+r')
  })

  it('rejects a flag the spec does not document', () => {
    expect(() => parse(['terminal', 'key', '--nope'])).toThrow(/Unknown flag/)
  })

  it('sends the chord verbatim so ONE parser owns the spelling', async () => {
    const { call, exitCode } = await run(
      ['terminal', 'key', '--terminal', 't1', '--key', 'ctrl+r'],
      SENT
    )
    expect(call).toHaveBeenCalledWith('terminal.key', { terminal: 't1', key: 'ctrl+r' })
    expect(exitCode).toBeUndefined()
  })

  it('exits non-zero when the keystroke never went out', async () => {
    const refused: TerminalKeyResult = {
      ...SENT,
      sent: false,
      bytes: null,
      byteLength: 0,
      events: 'none',
      refusal: { code: 'unknown-key', reason: 'no such key' }
    }
    const { exitCode, printed } = await run(
      ['terminal', 'key', '--terminal', 't1', '--key', 'Entre'],
      refused
    )
    // A chained `key && screen` must not go on to read an unchanged screen.
    expect(exitCode).toBe(1)
    expect(printed).toContain('unknown-key')
  })
})

describe('formatTerminalKey — what the plain view must never blur', () => {
  it('shows the bytes and the modes that produced them', () => {
    const text = formatTerminalKey(SENT)
    expect(text).toContain('Sent ctrl+r as \\x12')
    expect(text).toContain('disambiguate-esc-codes, application-cursor')
    expect(text).toContain('0x5')
  })

  it('never lets acceptance read as effect', () => {
    const text = formatTerminalKey(SENT)
    expect(text).toContain('NOT proof the program acted on it')
    expect(text).toContain('orca terminal screen')
  })

  it('tells an unknown key apart from a key these modes cannot encode', () => {
    const unknown = formatTerminalKey({
      ...SENT,
      sent: false,
      bytes: null,
      refusal: { code: 'unknown-key', reason: 'x' }
    })
    const unencodable = formatTerminalKey({
      ...SENT,
      sent: false,
      bytes: null,
      refusal: { code: 'not-encodable', reason: 'x' }
    })
    expect(unknown).toContain('no engine key has that name')
    expect(unencodable).toContain('the key exists but this pane’s current modes give it no bytes')
    for (const text of [unknown, unencodable]) {
      expect(text).toContain('Nothing was written to the terminal.')
    }
  })

  it('says the modes are unknown rather than showing an empty mode list', () => {
    const text = formatTerminalKey({
      ...SENT,
      sent: false,
      bytes: null,
      modes: null,
      refusal: { code: 'no-headless-engine', reason: 'x' }
    })
    // An empty "Encoded against: none" would read as a fact about the pane.
    expect(text).toContain('modes unknown')
    expect(text).toContain('nothing was guessed')
  })
})
