import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { initSync, AtermTerminal } from './aterm_wasm.js'
import { ATERM_RENDERER_FONT_PX } from './aterm-pane-controller-types'

// The cursor-effects FOCUS GATE, pinned against the REAL committed wasm artifact.
//
// Natively an unfocused window is suppressed by a motion-policy amplitude fold, and
// the engine was built expecting that contract (cursor_glow documents "unfocus
// arrives as intensity <= 0"). The web/worker path never delivered it, so in a SPLIT
// — where a pane is unfocused but still VISIBLE and rendered — every unfocused pane
// animated its cursor at full strength: wrong affordance, and N panes pinning the
// shared render loop instead of settling.
//
// The engine-side unit tests cover the Rust source. This covers what actually SHIPS:
// the wasm binary the app loads. If a future re-pin drops the gate, this fails here
// rather than in a user's split.
const ATERM_DIR = new URL('./', import.meta.url)
const FONT_URL = new URL('../../../assets/fonts/jetbrains-mono.ttf', import.meta.url)

const ROWS = 10
const COLS = 40

let fontBytes: Uint8Array

beforeAll(() => {
  initSync({ module: readFileSync(new URL('aterm_wasm_bg.wasm', ATERM_DIR)) })
  fontBytes = new Uint8Array(readFileSync(FONT_URL))
})

function openTerminal(): AtermTerminal {
  return new AtermTerminal(
    ROWS,
    COLS,
    fontBytes,
    ATERM_RENDERER_FONT_PX,
    0xffffff,
    0x000000,
    0xffffff,
    0x334455
  )
}

/** Arm a non-Fire glow and drive cursor motion, the way typing does. Fire is
 *  excluded deliberately: it keeps a bounded ember tail by design. */
function armGlowAndType(term: AtermTerminal, text: string): void {
  term.set_cursor_glow(true, 'lumen', null, null, 400, 24, 0.9, 0.9, true)
  const bytes = new TextEncoder().encode(text)
  for (const byte of bytes) {
    // note_keystroke feeds the typing cadence that ignites the wake; process moves
    // the cursor, which is what actually spawns light.
    term.note_keystroke()
    term.process(new Uint8Array([byte]))
    term.advance_effects(30)
    // The effects pipeline ticks inside the render pass, not on advance alone.
    term.render()
  }
}

/** Tick as an unfocused-but-visible pane does: the host keeps rendering it. Two
 *  frames — the first arms the engine's lazy-cooling clock, the second cools. */
function tickDark(term: AtermTerminal): void {
  for (let i = 0; i < 2; i += 1) {
    term.advance_effects(16)
    term.render()
  }
}

describe('aterm cursor-effects focus gate (real committed wasm)', () => {
  it('a focused pane drives live cursor effects', () => {
    const term = openTerminal()
    term.set_effects_visibility('focused')
    armGlowAndType(term, 'abc')
    // Proven FIRST so the unfocused assertions below can never pass vacuously.
    expect(term.is_effects_active()).toBe(true)
  })

  it('an unfocused-but-visible pane settles, so the shared render loop drops it', () => {
    const term = openTerminal()
    term.set_effects_visibility('focused')
    armGlowAndType(term, 'abc')
    expect(term.is_effects_active()).toBe(true)

    // The split case: still visible, still ticking, just not focused. Two ticks —
    // the first arms the engine's lazy-cooling clock, the second cools through it.
    term.set_effects_visibility('visible_unfocused')
    tickDark(term)
    expect(term.is_effects_active()).toBe(false)

    // CONTROL: an identically-driven pane that stays FOCUSED is still animating
    // after the same two ticks. Without this the assertion above would also pass
    // if the effects had merely decayed on their own — it pins FOCUS as the cause.
    const focused = openTerminal()
    focused.set_effects_visibility('focused')
    armGlowAndType(focused, 'abc')
    tickDark(focused)
    expect(focused.is_effects_active()).toBe(true)
  })

  it('refocusing brings the effects back', () => {
    const term = openTerminal()
    term.set_effects_visibility('focused')
    armGlowAndType(term, 'abc')

    term.set_effects_visibility('visible_unfocused')
    tickDark(term)
    expect(term.is_effects_active()).toBe(false)

    term.set_effects_visibility('focused')
    armGlowAndType(term, 'def')
    expect(term.is_effects_active()).toBe(true)
  })

  it('the legacy boolean setter gates identically to the tri-state one', () => {
    const term = openTerminal()
    term.set_effects_focused(true)
    armGlowAndType(term, 'abc')
    expect(term.is_effects_active()).toBe(true)

    term.set_effects_focused(false)
    tickDark(term)
    expect(term.is_effects_active()).toBe(false)
  })
})
