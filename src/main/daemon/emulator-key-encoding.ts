// One keystroke encoded off the headless engine, split from headless-emulator.ts
// (line budget) like the styled-frame and inline-image bridges beside it.
//
// The four-way outcome is the module's reason to exist, and it is the input-side
// mirror of emulator-styled-frame.ts. "There is no such key", "this key means
// nothing in these modes", "this build has no key binding" and "this engine is
// poisoned" would all collapse into zero bytes — and a caller that cannot tell
// them apart either retries a typo forever or believes it pressed something.
import type { RustHeadlessTerminalHandle, RustKeyEncoding } from './rust-terminal-addon'

export type EmulatorKeyEncodingRequest = {
  /** A DOM `KeyboardEvent.key` value; the engine's table is the authority. */
  key: string
  /** Engine `Modifiers` bitfield: SHIFT=1, ALT=2, CTRL=4, SUPER=8. */
  modifierBits: number
}

export type EmulatorKeyEncodingRead =
  | { outcome: 'encoding'; encoding: RustKeyEncoding }
  /** The addon predates `terminal.key`: this build cannot encode for any pane. */
  | { outcome: 'unsupported' }
  /** A live engine exists but could not answer (disposed, or poisoned). */
  | { outcome: 'unreadable' }

export const UNREADABLE_KEY_ENCODING: EmulatorKeyEncodingRead = { outcome: 'unreadable' }

export function readEmulatorKeyEncoding(
  term: RustHeadlessTerminalHandle,
  request: EmulatorKeyEncodingRequest
): EmulatorKeyEncodingRead {
  const encode = term.encodeKey?.bind(term)
  if (!encode) {
    return { outcome: 'unsupported' }
  }
  const encoding = encode(request.key, request.modifierBits)
  // Null is a disposed engine, never an empty encoding — so "this key is not
  // encodable here" can never be fabricated out of an engine that never ran.
  return encoding ? { outcome: 'encoding', encoding } : UNREADABLE_KEY_ENCODING
}
