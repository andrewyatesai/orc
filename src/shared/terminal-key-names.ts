/**
 * How a caller SPELLS a keystroke for `terminal.key`, and how that spelling
 * becomes the DOM `KeyboardEvent.key` value the engine's table speaks.
 *
 * The engine owns which keys exist — `aterm_types::keyboard::map_dom_key`, the
 * same table the GUI's real keyboard goes through. This module owns only the
 * ergonomics on top of it, and deliberately does NOT keep its own list of valid
 * keys: an unrecognised name is passed through UNCHANGED so the engine refuses
 * it by name. A second table here would drift from the first one, and a driver
 * would get "unknown key" for a key the terminal actually supports.
 *
 * What it does own:
 *
 * * **Friendly aliases.** `esc`, `pgup`, `up`, `f5` — the spellings a person or
 *   an AI writes, mapped onto the DOM values (`Escape`, `PageUp`, `ArrowUp`,
 *   `F5`). The DOM spellings keep working, so both vocabularies are legal.
 * * **Chord strings.** `ctrl+r` is one token in every keybinding document ever
 *   written, so both faces accept it and union it with any explicit modifiers.
 *   Parsing is leftward and stops at the first non-modifier token, which is why
 *   `ctrl++` presses `+` and `a+b` is passed on to be refused rather than
 *   silently read as a chord.
 */
import type { TerminalKeyModifierName } from './terminal-key-protocol'

/** Engine `Modifiers` bits: SHIFT=1, ALT=2, CTRL=4, SUPER=8. */
const MODIFIER_BITS: Record<TerminalKeyModifierName, number> = {
  shift: 1,
  alt: 2,
  ctrl: 4,
  super: 8
}

/** Canonical order for reporting, so two identical chords read identically. */
const MODIFIER_ORDER: readonly TerminalKeyModifierName[] = ['ctrl', 'alt', 'shift', 'super']

/** `meta`/`cmd`/`win` are Super: on every platform the DOM reports that key as
 *  `Meta`, and the engine encodes it as SUPER. Naming it `meta` here would
 *  collide with xterm's `metaSendsEscape`, which is a different thing. */
const MODIFIER_ALIASES: Record<string, TerminalKeyModifierName> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  c: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  meta: 'super',
  cmd: 'super',
  command: 'super',
  super: 'super',
  win: 'super',
  shift: 'shift'
}

/** Friendly spelling -> DOM `KeyboardEvent.key`. Aliases only; the DOM values
 *  themselves are always accepted, and anything unlisted goes to the engine. */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  ret: 'Enter',
  cr: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  bs: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  space: ' ',
  spacebar: ' ',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  capslock: 'CapsLock',
  numlock: 'NumLock',
  scrolllock: 'ScrollLock',
  printscreen: 'PrintScreen',
  pause: 'Pause',
  menu: 'ContextMenu',
  contextmenu: 'ContextMenu'
}

/** The aliases worth showing a caller who got a name wrong. Function keys are
 *  described rather than enumerated — 35 of them would bury the rest. */
export const TERMINAL_KEY_ALIAS_NAMES: readonly string[] = Object.keys(KEY_ALIASES)

const FUNCTION_KEY = /^f([1-9]|[12]\d|3[0-5])$/

export type TerminalKeyChord = {
  /** The DOM `KeyboardEvent.key` value to encode. */
  key: string
  modifiers: TerminalKeyModifierName[]
  /** Engine `Modifiers` bitfield for the modifiers above. */
  modifierBits: number
}

/** Resolve one key name onto its DOM value.
 *
 *  A single character is itself (`a` and `A` are different keys and the case is
 *  load-bearing). A known alias becomes its DOM value. `f1`..`f35` become
 *  `F1`..`F35`. EVERYTHING ELSE is returned untouched, on purpose: the engine
 *  is the only authority on which keys exist, and it refuses by name. */
export function resolveTerminalKeyName(name: string): string {
  const trimmed = name.trim()
  if ([...trimmed].length === 1) {
    return trimmed
  }
  const lowered = trimmed.toLowerCase()
  const alias = KEY_ALIASES[lowered]
  if (alias !== undefined) {
    return alias
  }
  const fn = FUNCTION_KEY.exec(lowered)
  return fn ? `F${fn[1]}` : trimmed
}

/** Parse a chord string and union it with explicitly supplied modifiers.
 *
 *  Modifier tokens are consumed from the LEFT while each one is followed by
 *  `+`; the first token that is not a modifier ends the scan and the remainder
 *  is the key, verbatim. So `ctrl+shift+f5` is a chord, `ctrl++` is Ctrl and the
 *  `+` key, a bare `+` is the `+` key, and `a+b` stays `a+b` — an unresolvable
 *  name the engine will refuse, which is the right answer for it. */
export function parseTerminalKeyChord(
  input: string,
  supplied: Iterable<TerminalKeyModifierName> = []
): TerminalKeyChord {
  const modifiers = new Set<TerminalKeyModifierName>(supplied)
  let rest = input.trim()
  for (;;) {
    const plus = rest.indexOf('+')
    if (plus <= 0) {
      break
    }
    const token = MODIFIER_ALIASES[rest.slice(0, plus).toLowerCase()]
    if (!token) {
      break
    }
    modifiers.add(token)
    rest = rest.slice(plus + 1)
  }
  const ordered = MODIFIER_ORDER.filter((name) => modifiers.has(name))
  return {
    key: resolveTerminalKeyName(rest),
    modifiers: ordered,
    modifierBits: ordered.reduce((bits, name) => bits | MODIFIER_BITS[name], 0)
  }
}
