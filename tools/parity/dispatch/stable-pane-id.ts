// TS dispatch for the stable-pane-id parity module. The shared TS impl was
// DELETED (`src/shared/stable-pane-id.ts` keeps the branded types plus the UUID
// pattern, the 256 cap and the numeric-tail pattern) — every surface now reaches
// `orca_core::stable_pane_id` through `src/shared/stable-pane-identity.ts` on
// the orca-dispatch seam.
//
// Like the wsl-paths and worktree-id adapters, this drives the SHIM rather than
// the wasm oracle, and the harness keeps a real TS-vs-Rust differential instead
// of degenerating to wasm-vs-binary: config/vitest.parity.config.ts installs no
// setup file, so the seam is unbound here and the shim answers from its `parity`
// fallback — which is exactly the deleted body, and exactly the code the
// renderer runs before (or without) a binding.
import {
  isStablePaneId,
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../src/shared/stable-pane-identity'

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
