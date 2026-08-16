// TS dispatch for the stable-pane-id parity module: maps the shared vector
// function names to the real `src/shared/stable-pane-id.ts` exports so the
// harness compares the live TS reference against the Rust port.

import {
  isStablePaneId,
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../src/shared/stable-pane-id'

/** Mirrored verbatim in the Rust arm so a bad vector reads the same on both legs. */
const MAKE_PANE_KEY_SHAPE = 'makePaneKey expects { tabId: string, stableLeafId: string }'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'makePaneKey': {
      const { tabId, stableLeafId } = (input ?? {}) as {
        tabId?: unknown
        stableLeafId?: unknown
      }
      if (typeof tabId !== 'string' || typeof stableLeafId !== 'string') {
        return { __parity_error__: MAKE_PANE_KEY_SHAPE }
      }
      try {
        return makePaneKey(tabId, stableLeafId)
      } catch (err) {
        // The throw is the answer, and the Rust `Err` string has to equal this
        // message — so surface the text rather than collapsing it to null.
        return { __parity_error__: err instanceof Error ? err.message : String(err) }
      }
    }
    case 'isStablePaneId':
      return isStablePaneId(input as string)
    case 'isTerminalLeafId':
      return isTerminalLeafId(input as string)
    case 'parsePaneKey':
      return parsePaneKey(input as string)
    case 'parseLegacyNumericPaneKey':
      // Takes `unknown` and validates the type itself, so pass input straight through.
      return parseLegacyNumericPaneKey(input)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
