// terminal.key's state machine. Every test here is about ONE contract: a
// keystroke that did not go out must say why, by name, and must never be
// reported the same way as one that did.
import { describe, expect, it, vi } from 'vitest'
import { pressTerminalKey, type TerminalKeyPressPorts } from './terminal-key-press'
import type { EmulatorKeyEncodingRead } from '../daemon/emulator-key-encoding'
import type { TerminalInputLease } from './terminal-input-coordinator'
import type { ConnectionPin, LeaseRevokedReport } from './terminal-input-lease-preemption'

const PIN: ConnectionPin = { ptyIncarnationId: 'inc_1', connectionGeneration: 1 }

const TARGET = { handle: 'term_1', ptyId: 'pty_1', pin: PIN }

const REVOKED: LeaseRevokedReport = {
  operationId: 'op_1',
  ptyId: 'pty_1',
  writer: 'manager',
  cause: 'human-input',
  phase: 'idle',
  pin: PIN,
  at: 5,
  draftState: 'clean',
  retry: 'allowed',
  reason: 'a person started typing'
} as unknown as LeaseRevokedReport

function encoding(over: Partial<Record<string, unknown>> = {}): EmulatorKeyEncodingRead {
  return {
    outcome: 'encoding',
    encoding: {
      recognized: true,
      press: Buffer.from([0x12]),
      release: Buffer.alloc(0),
      modeBits: 0,
      ...over
    }
  } as EmulatorKeyEncodingRead
}

function fakeLease(over: Partial<TerminalInputLease> = {}): TerminalInputLease {
  return {
    operationId: 'op_1',
    ptyId: 'pty_1',
    writeAuthority: () => 'writer',
    checkRevoked: () => null,
    armSubmit: () => null,
    release: vi.fn(),
    ...over
  } as unknown as TerminalInputLease
}

function ports(over: Partial<TerminalKeyPressPorts> = {}): TerminalKeyPressPorts {
  return {
    acquireLease: vi.fn().mockResolvedValue({ ok: true, lease: fakeLease() }),
    encodeKey: () => encoding(),
    write: () => true,
    clock: { now: () => 100, sleep: async () => {} },
    ...over
  }
}

function request(over: Record<string, unknown> = {}) {
  return {
    target: TARGET,
    key: 'r',
    modifiers: ['ctrl' as const],
    modifierBits: 4,
    writer: 'manager' as const,
    ...over
  }
}

describe('pressTerminalKey', () => {
  it('writes the engine’s bytes once and reports them escaped', async () => {
    const write = vi.fn().mockReturnValue(true)
    const result = await pressTerminalKey(request(), ports({ write }))
    expect(result.sent).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(result.bytes).toBe('\\x12')
    expect(result.byteLength).toBe(1)
    expect(result.events).toBe('press')
    expect(result.operationId).toBe('op_1')
  })

  it('sends press and release as ONE write when the pane speaks Kitty', async () => {
    const write = vi.fn().mockReturnValue(true)
    const kitty = encoding({
      press: Buffer.from('[114;5u'),
      release: Buffer.from('[114;5:3u'),
      modeBits: 0b11
    })
    const result = await pressTerminalKey(request(), ports({ write, encodeKey: () => kitty }))
    expect(result.events).toBe('press+release')
    // One write, not two: a press that reaches the pane without its release
    // leaves a Kitty-speaking app believing the key is held down.
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][1]).toBe('[114;5u[114;5:3u')
    expect(result.modes?.flags).toEqual(['disambiguate-esc-codes', 'report-event-types'])
  })

  it('names the modes it encoded against, so a surprising byte is explainable', async () => {
    const result = await pressTerminalKey(
      request({ key: 'ArrowUp', modifiers: [], modifierBits: 0 }),
      ports({ encodeKey: () => encoding({ press: Buffer.from('OA'), modeBits: 0b100 }) })
    )
    expect(result.bytes).toBe('\\x1bOA')
    expect(result.modes).toEqual({
      modeBits: 4,
      flags: ['application-cursor'],
      source: 'runtime-headless-replay'
    })
  })

  it('refuses an unknown key by name and writes nothing', async () => {
    const write = vi.fn()
    const result = await pressTerminalKey(
      request({ key: 'Entre' }),
      ports({ write, encodeKey: () => encoding({ recognized: false, press: Buffer.alloc(0) }) })
    )
    expect(result.sent).toBe(false)
    expect(result.refusal?.code).toBe('unknown-key')
    expect(write).not.toHaveBeenCalled()
  })

  it('separates "no such key" from "no bytes in these modes"', async () => {
    const result = await pressTerminalKey(
      request({ key: 'Control', modifiers: [], modifierBits: 0 }),
      ports({ encodeKey: () => encoding({ press: Buffer.alloc(0), modeBits: 4 }) })
    )
    expect(result.refusal?.code).toBe('not-encodable')
    // The modes ride along: "means nothing here" is only useful with the here.
    expect(result.modes?.flags).toEqual(['application-cursor'])
  })

  it('refuses rather than guesses when the pane has no live engine', async () => {
    const write = vi.fn()
    const result = await pressTerminalKey(request(), ports({ write, encodeKey: () => null }))
    expect(result.refusal?.code).toBe('no-headless-engine')
    expect(result.modes).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('reports an addon with no key binding as such, not as an unknown key', async () => {
    const result = await pressTerminalKey(
      request(),
      ports({ encodeKey: () => ({ outcome: 'unsupported' }) })
    )
    expect(result.refusal?.code).toBe('addon-too-old')
  })

  it('reports a poisoned engine as engine-unavailable', async () => {
    const result = await pressTerminalKey(
      request(),
      ports({ encodeKey: () => ({ outcome: 'unreadable' }) })
    )
    expect(result.refusal?.code).toBe('engine-unavailable')
  })

  it('yields the pane to a human on a phone before it even asks for the lease', async () => {
    const acquireLease = vi.fn()
    const result = await pressTerminalKey(
      request(),
      ports({ acquireLease, humanDriverHoldsPane: () => true })
    )
    expect(result.refusal?.code).toBe('mobile-driver-active')
    expect(acquireLease).not.toHaveBeenCalled()
  })

  it('passes a lease refusal through under its own name', async () => {
    const result = await pressTerminalKey(
      request(),
      ports({
        acquireLease: vi.fn().mockResolvedValue({ ok: false, reason: 'generation-change' })
      })
    )
    expect(result.refusal?.code).toBe('generation-change')
    expect(result.operationId).toBeNull()
  })

  it('reports a preemption at the arm as preempted, with nothing written', async () => {
    const write = vi.fn()
    const lease = fakeLease({ armSubmit: () => REVOKED })
    const result = await pressTerminalKey(
      request(),
      ports({ write, acquireLease: vi.fn().mockResolvedValue({ ok: true, lease }) })
    )
    expect(result.refusal?.code).toBe('preempted')
    expect(result.sent).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('reports a terminal that refused the bytes rather than claiming a send', async () => {
    const result = await pressTerminalKey(request(), ports({ write: () => false }))
    expect(result.sent).toBe(false)
    expect(result.refusal?.code).toBe('write-refused')
    expect(result.bytes).toBeNull()
  })

  it('releases the lease on every path, including a refusal', async () => {
    const release = vi.fn()
    const lease = fakeLease({ release })
    await pressTerminalKey(
      request(),
      ports({
        acquireLease: vi.fn().mockResolvedValue({ ok: true, lease }),
        encodeKey: () => encoding({ recognized: false, press: Buffer.alloc(0) })
      })
    )
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('declares on every result that acceptance is not effect', async () => {
    const sent = await pressTerminalKey(request(), ports())
    const notSent = await pressTerminalKey(request(), ports({ encodeKey: () => null }))
    for (const result of [sent, notSent]) {
      expect(result.blindSpots.map((spot) => spot.reason)).toEqual([
        // The modes are a replay of the pane, not a reading of it — and the
        // encoding inherits that, so it is declared alongside the two effect gaps.
        'keyboard-modes-are-replayed-not-read',
        'keystroke-effect-not-observed',
        'write-acceptance-is-not-remote-delivery'
      ])
    }
  })
})
