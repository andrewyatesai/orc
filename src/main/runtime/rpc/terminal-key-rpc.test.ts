// Wire contract for terminal.key: chord parsing happens server-side (so the CLI
// and a socket caller cannot drift), an unrecognised modifier is rejected rather
// than dropped, and the result crosses the dispatcher intact.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_KEY_METHODS } from './methods/terminal-key'
import {
  TERMINAL_KEY_BLIND_SPOTS,
  type TerminalKeyResult
} from '../../../shared/terminal-key-protocol'

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
  modes: { modeBits: 0, flags: [], source: 'runtime-headless-replay' },
  operationId: 'op_1',
  decidedAt: 10,
  blindSpots: [...TERMINAL_KEY_BLIND_SPOTS]
}

function dispatcherWith(overrides: Partial<OrcaRuntimeService>) {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: TERMINAL_KEY_METHODS })
}

function request(params: Record<string, unknown>): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.key', params }
}

describe('terminal.key', () => {
  it('parses a chord into a DOM key plus engine modifier bits', async () => {
    const pressTerminalKey = vi.fn().mockResolvedValue(SENT)
    await dispatcherWith({ pressTerminalKey }).dispatch(
      request({ terminal: 'term_1', key: 'ctrl+r' })
    )
    expect(pressTerminalKey.mock.calls[0][1]).toBe('r')
    expect(pressTerminalKey.mock.calls[0][2]).toMatchObject({
      modifiers: ['ctrl'],
      modifierBits: 4
    })
  })

  it('unions structured modifiers with the chord instead of overriding them', async () => {
    const pressTerminalKey = vi.fn().mockResolvedValue(SENT)
    await dispatcherWith({ pressTerminalKey }).dispatch(
      request({ terminal: 'term_1', key: 'ctrl+r', modifiers: { shift: true } })
    )
    expect(pressTerminalKey.mock.calls[0][2]).toMatchObject({
      modifiers: ['ctrl', 'shift'],
      modifierBits: 5
    })
  })

  it('resolves an alias to the DOM name the engine speaks', async () => {
    const pressTerminalKey = vi.fn().mockResolvedValue(SENT)
    await dispatcherWith({ pressTerminalKey }).dispatch(
      request({ terminal: 'term_1', key: 'pgup' })
    )
    expect(pressTerminalKey.mock.calls[0][1]).toBe('PageUp')
  })

  it('rejects a modifier name it does not know rather than dropping it', async () => {
    const pressTerminalKey = vi.fn()
    const response = await dispatcherWith({ pressTerminalKey }).dispatch(
      request({ terminal: 'term_1', key: 'k', modifiers: { cmd: true } })
    )
    // Silently dropping it would send a DIFFERENT keystroke than the one asked
    // for, which is exactly what this verb exists to avoid.
    expect(response.ok).toBe(false)
    expect(pressTerminalKey).not.toHaveBeenCalled()
  })

  it('rejects a missing key and a missing handle', async () => {
    const dispatcher = dispatcherWith({ pressTerminalKey: vi.fn() })
    expect((await dispatcher.dispatch(request({ terminal: 'term_1' }))).ok).toBe(false)
    expect((await dispatcher.dispatch(request({ key: 'r' }))).ok).toBe(false)
  })

  it('carries the refusal and the blind spots through untouched', async () => {
    const refused: TerminalKeyResult = {
      ...SENT,
      sent: false,
      bytes: null,
      byteLength: 0,
      events: 'none',
      refusal: { code: 'not-encodable', reason: 'no bytes in these modes' }
    }
    const response = await dispatcherWith({
      pressTerminalKey: vi.fn().mockResolvedValue(refused)
    }).dispatch(request({ terminal: 'term_1', key: 'Control' }))
    const { key } = (response as { result: { key: TerminalKeyResult } }).result
    expect(key.refusal?.code).toBe('not-encodable')
    expect(key.blindSpots.map((spot) => spot.reason)).toContain('keystroke-effect-not-observed')
  })
})
