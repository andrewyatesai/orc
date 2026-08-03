// Exercises the REAL napi addon end to end: a key name goes in, and the bytes
// the engine will itself interpret come back — against modes set by real escape
// sequences, not by a flag someone remembered to pass.
//
// This is the file that proves the claim the verb rests on. A TypeScript encoder
// can be tested against a table it wrote itself and still be wrong about the
// terminal; here the SAME engine that parsed `ESC [ ? 1 h` is the one deciding
// that Up is now `ESC O A`.
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

function emulator(): HeadlessEmulator {
  return new HeadlessEmulator({ cols: 40, rows: 6, scrollback: 1000 })
}

function press(term: HeadlessEmulator, key: string, modifierBits = 0) {
  const read = term.encodeKey({ key, modifierBits })
  if (read.outcome !== 'encoding') {
    throw new Error(`expected an encoding, got ${read.outcome}`)
  }
  return read.encoding
}

const CTRL = 4
const SHIFT = 1

describe('HeadlessEmulator.encodeKey', () => {
  it('encodes a control chord to its C0 byte', () => {
    const term = emulator()
    const encoded = press(term, 'r', CTRL)
    expect(encoded.recognized).toBe(true)
    expect([...encoded.press]).toEqual([0x12])
    expect([...encoded.release]).toEqual([])
    term.dispose()
  })

  it('follows DECCKM set by the program, not a caller-supplied guess', () => {
    const term = emulator()
    expect(press(term, 'ArrowUp').press.toString('latin1')).toBe('[A')
    term.writeSync('\x1b[?1h')
    const after = press(term, 'ArrowUp')
    expect(after.press.toString('latin1')).toBe('OA')
    // The audit trail: the caller can see WHICH mode changed the answer.
    expect(after.modeBits & 0b100).toBe(0b100)
    term.dispose()
  })

  it('re-encodes every key once the program negotiates the Kitty protocol', () => {
    const term = emulator()
    term.writeSync('\x1b[>3u')
    const encoded = press(term, 'r', CTRL)
    expect(encoded.press.toString('latin1')).toBe('[114;5u')
    // report-event-types was negotiated, so the human keystroke has a key-up
    // half and a driver sending only the press would leave the key "held".
    expect(encoded.release.toString('latin1')).toBe('[114;5:3u')
    term.dispose()
  })

  it('encodes Shift+Tab as back-tab', () => {
    const term = emulator()
    expect(press(term, 'Tab', SHIFT).press.toString('latin1')).toBe('[Z')
    term.dispose()
  })

  it('refuses an unknown name instead of approximating it', () => {
    const term = emulator()
    const encoded = press(term, 'Entre')
    expect(encoded.recognized).toBe(false)
    expect(encoded.press).toHaveLength(0)
    term.dispose()
  })

  it('separates a real key with no encoding from a name nothing knows', () => {
    const term = emulator()
    const modifierOnly = press(term, 'Control')
    expect(modifierOnly.recognized).toBe(true)
    expect(modifierOnly.press).toHaveLength(0)
    term.dispose()
  })

  it('answers unreadable after dispose rather than "this key means nothing"', () => {
    const term = emulator()
    term.dispose()
    expect(term.encodeKey({ key: 'r', modifierBits: CTRL }).outcome).toBe('unreadable')
  })
})
