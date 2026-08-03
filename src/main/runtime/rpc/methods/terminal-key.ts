/**
 * `terminal.key` — one keystroke, encoded by the engine that will interpret it
 * (docs/reference/alab-agent-visibility.md §5.3(b1)).
 *
 * A sibling of `terminal.submitAgentPrompt`, not an option on `terminal.send`:
 * send writes the caller's own bytes verbatim, which is the right contract for
 * text and the wrong one for a key. What a key MEANS on the wire is a function
 * of the pane's live modes, so the pane encodes it — the caller names the key.
 *
 * The handler stays thin: every decision in the result was made under the pane's
 * input lease, and re-deriving any of it here would be a second opinion.
 */
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { requiredString } from '../schemas'
import { parseTerminalKeyChord } from '../../../../shared/terminal-key-names'
import type { TerminalKeyModifierName } from '../../../../shared/terminal-key-protocol'

/** Strict, so a caller who writes `{ cmd: true }` is told instead of quietly
 *  having the modifier dropped — a chord silently missing a modifier is the
 *  wrong keystroke, and this verb exists to not send those. */
const TerminalKeyModifiers = z
  .object({
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
    super: z.boolean().optional()
  })
  .strict()

const TerminalKeyParams = z.object({
  terminal: requiredString('Missing terminal handle'),
  // A key name (`Enter`, `ArrowUp`, `esc`, `f5`, `a`) or a chord (`ctrl+r`).
  // Chord modifiers union with the `modifiers` object rather than override it.
  key: requiredString('Missing key'),
  modifiers: TerminalKeyModifiers.optional()
})

function suppliedModifiers(
  modifiers: z.infer<typeof TerminalKeyModifiers> | undefined
): TerminalKeyModifierName[] {
  if (!modifiers) {
    return []
  }
  const names: TerminalKeyModifierName[] = ['ctrl', 'alt', 'shift', 'super']
  return names.filter((name) => modifiers[name] === true)
}

export const TERMINAL_KEY_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.key',
    params: TerminalKeyParams,
    handler: async (params, { runtime, signal }) => {
      const chord = parseTerminalKeyChord(params.key, suppliedModifiers(params.modifiers))
      return {
        key: await runtime.pressTerminalKey(params.terminal, chord.key, {
          modifiers: chord.modifiers,
          modifierBits: chord.modifierBits,
          // A disconnected caller cancels the wait for the pane, never a
          // keystroke that has already been written.
          ...(signal ? { signal } : {})
        })
      }
    }
  })
]
