// Renderer terminal tab-id validity, driven by the Rust `orca_core::terminal_tab_id`
// core through the orca-git wasm (the shared TS twin is now data only).
//
// PRE-READY CONTRACT — both rows are `parity`, and that is FORCED, not a
// convenience. These predicates gate tab IDENTITY, and a sentinel has nowhere to
// go: every call site consumes the result inside `&&` or `.filter(...)`, where
// `null`/`undefined` is simply falsy and indistinguishable from a real `false`
// (ported-modules.md "Signal at the level that has a spare state" — a boolean has
// no third state, and lifting these to a list would not help, because each answer
// decides ONE id). A wrong `false` is not cosmetic either:
//   * store/slices/terminals.ts createTab ignores the caller's id hint and mints a
//     fresh UUID, so the renderer keys the tab under an id the host's PTY binding,
//     the pane key and agent-status routing never agree with — and it happens
//     inside a Zustand `set()`, where a throw would take the app down;
//   * store/slices/tabs-hydration.ts drops the tab from the restored session.
// So each fallback rebuilds the deleted twin's body verbatim from the two kept
// constants, which makes pre-ready equal ready for EVERY input — the same shape
// `git-publish-target-status` and the adjacent `terminal-surface-id` shim use for
// exactly the same reason.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import { DispatchPayloadError } from '../../../../shared/dispatch-payload-codec'
import { TERMINAL_TAB_ID_PANE_KEY_DELIMITER } from '../../../../shared/terminal-tab-id'
import { WEB_TERMINAL_SURFACE_TAB_PREFIX } from '../../../../shared/terminal-surface-id'

// Why the catch: tab ids arrive from persisted session JSON and from web/mobile
// clients, so one can carry a lone UTF-16 surrogate — which the codec refuses,
// correctly, because it cannot cross into Rust at all. The twin answered that
// input without crossing anything and this fallback computes the same answer, so
// falling back keeps a validator a validator instead of throwing inside `set()`.
// Only the encode rejection is caught; a DispatchCoreError still propagates.
function op(fn: string, value: string, fallback: boolean): boolean {
  if (!isGitWasmReady()) {
    return fallback
  }
  try {
    return dispatchToWasmCore('terminal-tab-id', fn, value, { root: 'tabId' }) as boolean
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return fallback
    }
    throw error
  }
}

export function isValidTerminalTabId(value: string): boolean {
  return op('isValidTerminalTabId', value, legacyIsValidTerminalTabId(value))
}

export function isValidHostTerminalTabId(value: string): boolean {
  return op(
    'isValidHostTerminalTabId',
    value,
    legacyIsValidTerminalTabId(value) && !value.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)
  )
}

function legacyIsValidTerminalTabId(value: string): boolean {
  return value.length > 0 && !value.includes(TERMINAL_TAB_ID_PANE_KEY_DELIMITER)
}
