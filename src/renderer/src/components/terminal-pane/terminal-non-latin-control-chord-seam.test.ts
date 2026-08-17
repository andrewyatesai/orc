// @vitest-environment happy-dom
// Drives resolveNonLatinControlChordInput + isNonLatinControlChordKeyup wired in the
// same order use-terminal-pane-lifecycle wires them into attachCustomKeyEventHandler:
// a keydown resolves the chord, sends the C0 byte, and records the physical code; the
// matching keyup is swallowed against that recorded code so a kitty release report for
// the swallowed press cannot leak. The pure-module test exercises each function alone;
// this pins the stateful two-event sequence the claimedNonLatinControlChordCode holds.
import { describe, expect, it } from 'vitest'
import {
  isNonLatinControlChordKeyup,
  resolveNonLatinControlChordInput
} from './terminal-non-latin-control-chord'

type Harness = {
  sentToPty: string[]
  // Returns whether the engine encoder would have run (the lifecycle returns !bypass;
  // here a claimed chord returns false, everything else returns true).
  handleKeyEvent: (event: KeyboardEvent) => boolean
}

function open(): Harness {
  const sentToPty: string[] = []
  // Mirrors the lifecycle wiring order: the keyup-swallow arm runs before the
  // resolve arm, both before the engine encoder would see the event.
  let claimedNonLatinControlChordCode: string | null = null
  const handleKeyEvent = (event: KeyboardEvent): boolean => {
    if (isNonLatinControlChordKeyup(event, claimedNonLatinControlChordCode)) {
      claimedNonLatinControlChordCode = null
      return false
    }
    const chord = resolveNonLatinControlChordInput(event)
    if (chord) {
      claimedNonLatinControlChordCode = event.code
      sentToPty.push(chord)
      return false
    }
    return true
  }
  return { sentToPty, handleKeyEvent }
}

function key(type: string, init: { key: string; code: string; ctrlKey?: boolean }): KeyboardEvent {
  return new KeyboardEvent(type, {
    key: init.key,
    code: init.code,
    ctrlKey: init.ctrlKey ?? true,
    bubbles: true,
    cancelable: true
  })
}

describe('non-Latin control chord lifecycle seam', () => {
  it('sends the C0 byte on keydown and swallows the matching keyup', () => {
    const h = open()
    // Korean 2-Set: physical A carries glyph ㅁ; Ctrl must still send SOH.
    const downEncodes = h.handleKeyEvent(key('keydown', { key: 'ㅁ', code: 'KeyA' }))
    expect(downEncodes).toBe(false)
    expect(h.sentToPty).toEqual(['\x01'])

    // The release of the same physical key is swallowed (Ctrl may already be up).
    const upEncodes = h.handleKeyEvent(key('keyup', { key: 'ㅁ', code: 'KeyA', ctrlKey: false }))
    expect(upEncodes).toBe(false)
    expect(h.sentToPty).toEqual(['\x01'])
  })

  it('does not swallow an unrelated keyup after the chord is released', () => {
    const h = open()
    h.handleKeyEvent(key('keydown', { key: 'ㅁ', code: 'KeyA' }))
    h.handleKeyEvent(key('keyup', { key: 'ㅁ', code: 'KeyA', ctrlKey: false }))
    // A later release on a different physical key must reach the engine.
    const upEncodes = h.handleKeyEvent(key('keyup', { key: 'b', code: 'KeyB', ctrlKey: false }))
    expect(upEncodes).toBe(true)
  })

  it('leaves an ASCII logical key to the engine encoder', () => {
    const h = open()
    // Dvorak moved the letter but reported a real ASCII key — authoritative, not ours.
    const downEncodes = h.handleKeyEvent(key('keydown', { key: 'a', code: 'KeyA' }))
    expect(downEncodes).toBe(true)
    expect(h.sentToPty).toEqual([])
  })

  it('leaves Ctrl+C on a non-Latin layout to the interrupt policy', () => {
    const h = open()
    // KeyC is excluded so the interrupt/copy policy that runs first owns it.
    const downEncodes = h.handleKeyEvent(key('keydown', { key: 'ㅊ', code: 'KeyC' }))
    expect(downEncodes).toBe(true)
    expect(h.sentToPty).toEqual([])
  })
})
