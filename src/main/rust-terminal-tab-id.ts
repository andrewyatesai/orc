// Main-process terminal tab-id validity, driven by the Rust
// `orca_core::terminal_tab_id` core via napi (the shared TS twin is now data only).
// Same non-empty/no-`:` rule the renderer runs through wasm and the Rust workspace
// session parser applies at `p_terminal_tab_id` — one source of truth.
//
// There is no pre-ready window here: napi binds synchronously at bootstrap. The
// fallback below exists for ONE input class the codec refuses (see `op`).
import { dispatchToRustCore } from './rust-core-dispatch'
import { DispatchPayloadError } from '../shared/dispatch-payload-codec'
import { TERMINAL_TAB_ID_PANE_KEY_DELIMITER } from '../shared/terminal-tab-id'
import { WEB_TERMINAL_SURFACE_TAB_PREFIX } from '../shared/terminal-surface-id'

// Why the catch: every main caller validates an UNTRUSTED tabId — `ipc/pty.ts`
// off IPC args, `ssh/ssh-relay-session.ts` off a persisted lease,
// `ipc/agent-status-ipc-boundary.ts` off a hook payload — so one can carry a lone
// UTF-16 surrogate, which the codec refuses because it cannot cross into Rust.
// The deleted twin answered that input without crossing anything and the fallback
// computes the same answer, so a malformed id stays a `false`/`true` here instead
// of throwing out of an IPC handler. Only the encode rejection is caught; a
// DispatchCoreError still propagates.
function op(fn: string, value: string, fallback: boolean): boolean {
  try {
    return dispatchToRustCore('terminal-tab-id', fn, value, { root: 'tabId' }) as boolean
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
