// The spelling layer: aliases, chords, and the deliberate refusal to keep a
// second list of "valid" keys. The last property is the important one — the
// engine's table is the only authority on which keys exist, so an unresolvable
// name must reach it UNCHANGED rather than be rejected here.
import { describe, expect, it } from 'vitest'
import { parseTerminalKeyChord, resolveTerminalKeyName } from './terminal-key-names'

describe('resolveTerminalKeyName', () => {
  it('keeps a single character verbatim, case included', () => {
    expect(resolveTerminalKeyName('a')).toBe('a')
    expect(resolveTerminalKeyName('A')).toBe('A')
    expect(resolveTerminalKeyName('+')).toBe('+')
  })

  it('maps friendly aliases onto their DOM key values', () => {
    expect(resolveTerminalKeyName('esc')).toBe('Escape')
    expect(resolveTerminalKeyName('pgup')).toBe('PageUp')
    expect(resolveTerminalKeyName('up')).toBe('ArrowUp')
    expect(resolveTerminalKeyName('space')).toBe(' ')
  })

  it('accepts the DOM spellings themselves', () => {
    expect(resolveTerminalKeyName('ArrowDown')).toBe('ArrowDown')
    expect(resolveTerminalKeyName('Enter')).toBe('Enter')
  })

  it('normalises function keys across the range the engine covers', () => {
    expect(resolveTerminalKeyName('f5')).toBe('F5')
    expect(resolveTerminalKeyName('F12')).toBe('F12')
    expect(resolveTerminalKeyName('f35')).toBe('F35')
    // F36 is past the engine's range: passed through, refused by the engine.
    expect(resolveTerminalKeyName('f36')).toBe('f36')
  })

  it('passes an unknown name through instead of judging it here', () => {
    expect(resolveTerminalKeyName('MediaPlay')).toBe('MediaPlay')
    expect(resolveTerminalKeyName('Entre')).toBe('Entre')
  })
})

describe('parseTerminalKeyChord', () => {
  it('reads a chord and reports the engine modifier bits', () => {
    expect(parseTerminalKeyChord('ctrl+r')).toEqual({
      key: 'r',
      modifiers: ['ctrl'],
      modifierBits: 4
    })
  })

  it('orders modifiers canonically however they were written', () => {
    const written = parseTerminalKeyChord('shift+ctrl+f5')
    expect(written.key).toBe('F5')
    expect(written.modifiers).toEqual(['ctrl', 'shift'])
    expect(written.modifierBits).toBe(5)
  })

  it('unions the chord modifiers with the ones supplied structurally', () => {
    const chord = parseTerminalKeyChord('ctrl+r', ['shift'])
    expect(chord.modifiers).toEqual(['ctrl', 'shift'])
    expect(chord.modifierBits).toBe(5)
  })

  it('treats cmd/meta/win as Super, which is what the engine encodes', () => {
    expect(parseTerminalKeyChord('cmd+k').modifierBits).toBe(8)
    expect(parseTerminalKeyChord('meta+k').modifiers).toEqual(['super'])
    expect(parseTerminalKeyChord('win+k').modifiers).toEqual(['super'])
  })

  it('presses the plus key rather than eating it as a separator', () => {
    expect(parseTerminalKeyChord('+')).toMatchObject({ key: '+', modifiers: [] })
    expect(parseTerminalKeyChord('ctrl++')).toMatchObject({ key: '+', modifiers: ['ctrl'] })
  })

  it('does not read a non-modifier token as a chord', () => {
    // 'a+b' is not two keys and not a chord; it stays whole so the engine can
    // refuse it by name instead of this layer inventing a keystroke.
    expect(parseTerminalKeyChord('a+b')).toMatchObject({ key: 'a+b', modifiers: [] })
  })

  it('never encodes a modifier twice', () => {
    expect(parseTerminalKeyChord('ctrl+control+r').modifiers).toEqual(['ctrl'])
  })
})
