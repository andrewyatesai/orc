/**
 * Wire types for `terminal.key` — one keystroke, encoded by the engine that
 * will interpret it (docs/reference/alab-agent-visibility.md §5.3(b1), §8.5).
 *
 * The verb exists because some things an agent TUI shows can only be reached by
 * pressing the key a human would press: an agent's own `… +N lines` collapse is
 * the case that motivated it, and no read verb can expand it because those
 * bytes were never written to the terminal at all.
 *
 * Why a key verb rather than `terminal.send --text $'\x12'`: the bytes a key
 * MEANS depend on the pane's live modes. DECCKM decides whether Up is `ESC [ A`
 * or `ESC O A`; a negotiated Kitty flag turns Ctrl+R from one byte into a CSI-u
 * report and adds a key-up event; xterm modifyOtherKeys re-encodes the modified
 * keys; DECBKM swaps Backspace between DEL and BS. A caller hand-rolling those
 * bytes is maintaining a second opinion about a terminal that is sitting right
 * there, able to answer.
 *
 * Two honesty rules shape the result:
 *
 * 1. **A key that cannot be encoded is refused BY NAME.** `unknown-key` (the
 *    engine's table has no such key) and `not-encodable` (it has one, and these
 *    modes give it no bytes) are separate codes, because one is a typo and the
 *    other is a fact about the pane. Neither is ever an approximation — a wrong
 *    escape sequence in a TUI is worse than no keystroke.
 * 2. **`sent: true` is about BYTES, not about effect.** Nothing here watches the
 *    screen, and over SSH local write acceptance is not delivery proof. Both
 *    limits ride on every result as blind spots, and `terminal.screen` is the
 *    oracle that answers "did the display change".
 */
import type { TerminalContextBlindSpot } from './terminal-context-protocol'

export const TERMINAL_KEY_SCHEMA_VERSION = 1

/** The four chord modifiers. Locks (Caps/Num) are state, not a press, and the
 *  engine masks them off rather than let them re-encode a key. */
export type TerminalKeyModifierName = 'ctrl' | 'alt' | 'shift' | 'super'

export type TerminalKeyRefusalCode =
  /** The engine's key table has no key by this name — a caller-side mistake. */
  | 'unknown-key'
  /** A real key that these modes give no encoding (a bare modifier key, a
   *  Kitty-only report on a pane that never negotiated Kitty). */
  | 'not-encodable'
  /** The pane has no live engine, so its modes are unknown. Encoding anyway
   *  would be a guess, and the guess is the thing this verb exists to avoid. */
  | 'no-headless-engine'
  /** A live engine could not answer (disposed, or poisoned by a native panic). */
  | 'engine-unavailable'
  /** This build has no key binding at all — it cannot encode for any pane. */
  | 'addon-too-old'
  | 'pty-disposed'
  | 'generation-change'
  | 'cancelled'
  /** A person is driving this pane from a phone; automation yields (§5.4). */
  | 'mobile-driver-active'
  /** A human took the pane between the lease and the keypress. */
  | 'preempted'
  /** A two-phase human claim reserved the pane and never decided. The pane was
   *  not lost; this keystroke gave it up rather than hold the lease forever. */
  | 'human-claim-undecided'
  /** The terminal refused the bytes. Nothing partial is ever left behind: the
   *  whole keystroke is one write. */
  | 'write-refused'

/** The `KeyboardMode` flags the encoding was made against, named. Unknown bits
 *  are dropped rather than invented — `modeBits` keeps the lossless value. */
export type TerminalKeyboardModeFlag =
  | 'disambiguate-esc-codes'
  | 'report-event-types'
  | 'application-cursor'
  | 'application-keypad'
  | 'modify-other-keys-1'
  | 'modify-other-keys-2'
  | 'format-other-keys'
  | 'report-alternate-keys'
  | 'report-all-keys-as-esc'
  | 'report-associated-text'
  | 'vt52'
  | 'backarrow-sends-bs'
  | 'alt-no-esc'
  | 'meta-sends-esc'
  | 'no-special-modifiers'

/** Bit positions of `aterm_types::keyboard::KeyboardMode`, which is the
 *  authority. Kept as a table rather than derived so a caller reading `--json`
 *  gets names, and so a future engine flag shows up as an unnamed bit in
 *  `modeBits` instead of silently renaming an existing one. */
export const TERMINAL_KEYBOARD_MODE_FLAGS: readonly TerminalKeyboardModeFlag[] = [
  'disambiguate-esc-codes',
  'report-event-types',
  'application-cursor',
  'application-keypad',
  'modify-other-keys-1',
  'modify-other-keys-2',
  'format-other-keys',
  'report-alternate-keys',
  'report-all-keys-as-esc',
  'report-associated-text',
  'vt52',
  'backarrow-sends-bs',
  'alt-no-esc',
  'meta-sends-esc',
  'no-special-modifiers'
]

export type TerminalKeyEncodingModes = {
  /** Raw `KeyboardMode` bits — lossless, and the tie-breaker if a future engine
   *  flag has no name in this build. */
  modeBits: number
  /** The bits above, named. Only the ones this build knows. */
  flags: TerminalKeyboardModeFlag[]
  /** Where these bits came from. Always `runtime-headless-replay`: the engine
   *  that answers here is this process's reconstruction of the pane's byte
   *  stream, NOT the emulator the program negotiated with. It is the best
   *  available model of the pane's keyboard state and is not a reading of it. */
  source: 'runtime-headless-replay'
}

/** Which halves of the keystroke went out. A pane that negotiated the Kitty
 *  `REPORT_EVENT_TYPES` enhancement is told about key-up too, and sending only
 *  the press would leave the application believing the key is still held. */
export type TerminalKeyEvents = 'none' | 'press' | 'press+release'

export type TerminalKeyResult = {
  schema: number
  handle: string
  ptyId: string | null
  /** The key name as resolved — the DOM `KeyboardEvent.key` value the engine's
   *  table speaks, which is what was actually encoded, not what was typed. */
  key: string
  modifiers: TerminalKeyModifierName[]
  /** Every byte of the keystroke was accepted by the terminal. Never a claim
   *  about what the program did with it — see `blindSpots`. */
  sent: boolean
  /** What was written, `\xNN`-escaped so it survives JSON and a log. Null when
   *  nothing was written. */
  bytes: string | null
  byteLength: number
  events: TerminalKeyEvents
  /** The modes the encoding was made against. Null when it never got that far. */
  modes: TerminalKeyEncodingModes | null
  /** The input lease this keystroke held, for joining against a preemption
   *  report. Null when no lease was ever granted. */
  operationId: string | null
  refusal?: { code: TerminalKeyRefusalCode; reason: string }
  decidedAt: number
  blindSpots: TerminalContextBlindSpot[]
}

/** The limit that matters most, and the reason `terminal.screen` is this verb's
 *  companion rather than a nicety. */
export const TERMINAL_KEY_NO_EFFECT_EVIDENCE_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'agent-screen-state',
  reason: 'keystroke-effect-not-observed',
  detail:
    'sent:true means the terminal accepted the bytes, not that the program acted on them. Nothing here watches the screen: a key the TUI ignores, or one it binds to something else, reports exactly the same result. Read terminal.screen before and after to see whether the display changed.'
}

/** The SSH half of the same caution, kept separate because it is true even when
 *  the program DID act: the acceptance was measured on the wrong side. */
export const TERMINAL_KEY_LOCAL_ACCEPTANCE_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'agent-screen-state',
  reason: 'write-acceptance-is-not-remote-delivery',
  detail:
    'For a relayed or SSH-hosted pane, acceptance is local: the bytes entered the transport, which is not proof they reached the remote PTY. The same rule terminal.send follows — evidence comes from reading the pane, not from the write returning true.'
}

/** The provenance caveat, which reaches further than it first appears: the
 *  encoding is DERIVED from these bits, so if the replay has drifted from the
 *  pane's real negotiated state, the bytes are wrong too — not merely the
 *  reported modes. */
export const TERMINAL_KEY_REPLAYED_MODES_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'agent-screen-state',
  reason: 'keyboard-modes-are-replayed-not-read',
  detail:
    "The reported KeyboardMode bits come from this runtime's headless replay of the pane's output, not from the emulator the program is actually talking to. On a live pane that replay is rebuilt from the retained stream and can drift from the real negotiated state — so both these flags and the bytes encoded from them are a best model, not a reading. Confirm the keystroke landed with terminal.screen rather than trusting the mode report."
}

export const TERMINAL_KEY_BLIND_SPOTS: readonly TerminalContextBlindSpot[] = [
  TERMINAL_KEY_REPLAYED_MODES_BLIND_SPOT,
  TERMINAL_KEY_NO_EFFECT_EVIDENCE_BLIND_SPOT,
  TERMINAL_KEY_LOCAL_ACCEPTANCE_BLIND_SPOT
]

/** Name the `KeyboardMode` bits this build knows, dropping the ones it does
 *  not. Dropping rather than guessing: an unnamed bit must not make this build
 *  claim it understood a mode it has never heard of. */
export function namedKeyboardModeFlags(modeBits: number): TerminalKeyboardModeFlag[] {
  const flags: TerminalKeyboardModeFlag[] = []
  TERMINAL_KEYBOARD_MODE_FLAGS.forEach((flag, bit) => {
    if ((modeBits & (1 << bit)) !== 0) {
      flags.push(flag)
    }
  })
  return flags
}

/** Render bytes for humans and for JSON: printable ASCII as itself, everything
 *  else as `\xNN`. A driver comparing two keystrokes needs to see `\x1b[A`, and
 *  a raw ESC in a log line rewrites the reader's own terminal. */
export function escapeTerminalKeyBytes(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`
  }
  return out
}
