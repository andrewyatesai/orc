/**
 * Human-readable rendering for `orca terminal key`.
 *
 * Three things this view must never blur, because each of them is a different
 * instruction to the caller:
 *
 *  * A refusal names WHY, and whether the fix is on the caller's side (a key
 *    name nothing knows) or the pane's (a mode that gives it no bytes).
 *  * A sent keystroke shows the BYTES the engine chose and the modes it chose
 *    them under, so "why did Up send ESC O A" is answerable from the output.
 *  * Sent is not done. Nothing here watched the screen, so the last line always
 *    points at the verb that can.
 */
import type { TerminalKeyModifierName, TerminalKeyResult } from '../shared/terminal-key-protocol'

const REFUSAL_FIX: Record<string, string> = {
  'unknown-key':
    'no engine key has that name — try a DOM name (Enter, ArrowUp, F5), an alias (esc, pgup, up), or a single character',
  'not-encodable':
    'the key exists but this pane’s current modes give it no bytes — a bare modifier key, or a Kitty-only report on a pane that never negotiated Kitty',
  'no-headless-engine':
    'this pane has no live engine (parked, cold, or not yet hydrated), so its keyboard modes are unknown — nothing was guessed',
  'engine-unavailable': 'the engine for this pane could not answer',
  'addon-too-old': 'this build has no key-encoding binding at all, on any pane',
  'mobile-driver-active': 'a person is driving this pane from a phone; automation yields to them',
  preempted: 'a person took the keyboard before the key landed — nothing was written',
  'human-claim-undecided':
    'a phone claim reserved the pane and never decided; the keystroke gave the pane up rather than hold it',
  'write-refused': 'the terminal refused the bytes — nothing partial was left behind',
  'pty-disposed': 'the terminal is no longer running',
  'generation-change': 'the terminal was replaced by a newer incarnation — re-resolve the handle',
  cancelled: 'the caller cancelled before the key was sent'
}

function chord(key: string, modifiers: TerminalKeyModifierName[]): string {
  return [...modifiers, key].join('+')
}

function modesLine(result: TerminalKeyResult): string {
  const modes = result.modes
  if (!modes) {
    return 'Encoded against: modes unknown — the key never reached the encoder.'
  }
  const flags = modes.flags.length > 0 ? modes.flags.join(', ') : 'none (plain cooked keys)'
  // The provenance belongs on the same line as the flags: these bits come from
  // Orca's replay of the pane, and the bytes above were encoded from them, so a
  // reader weighing a surprising keystroke needs both facts together.
  return `Encoded against: ${flags} (KeyboardMode 0x${modes.modeBits.toString(16)}, from Orca's replay of this pane — not read from the program's own emulator)`
}

export function formatTerminalKey(result: TerminalKeyResult): string {
  const pressed = chord(result.key, result.modifiers)
  if (result.refusal) {
    const fix = REFUSAL_FIX[result.refusal.code] ?? result.refusal.reason
    return [
      `Not sent: ${pressed} — ${result.refusal.code}.`,
      `  ${fix}.`,
      modesLine(result),
      'Nothing was written to the terminal.'
    ].join('\n')
  }
  return [
    `Sent ${pressed} as ${result.bytes} (${result.byteLength} byte(s), ${result.events}).`,
    modesLine(result),
    // The line that keeps this verb honest: acceptance is bytes, never effect,
    // and over SSH it is not even proof of delivery.
    'Accepted by the terminal — NOT proof the program acted on it, and on a relayed pane not proof it arrived. Read `orca terminal screen` to see what changed.'
  ].join('\n')
}
