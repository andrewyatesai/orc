// Tree-agnostic terminal tab-id validity, for the `src/shared` modules that run on
// MORE than one surface and so cannot import either tree's binding: this one goes
// through `orca-dispatch-seam` (main/cli bind napi, relay binds wasm via initSync,
// the renderer binds at wasm ready). Its consumers are the two wire/persistence
// guards — `agent-session-host-authority.isAgentSessionSurfaceBinding` (main daemon
// + relay) and `workspace-session-sleeping-agents`'s zod refine.
//
// main and renderer code must NOT import this: they have their own seam
// (`src/main/rust-terminal-tab-id.ts`, `src/renderer/src/lib/git-wasm/terminal-tab-id.ts`).
//
// PRE-READY CONTRACT — `parity`. Unlike `quick-open-filter`, this module is also
// bundled into the renderer, whose seam is unbound until the wasm compiles, so
// `requireOrcaDispatch` would turn a wire guard into a throw. It uses
// `tryOrcaDispatch` and rebuilds the deleted twin's body from its kept delimiter
// for the unbound case, so the answer is the twin's answer for every input — the
// only safe choice for a predicate whose `false` REJECTS a live agent session's
// surface binding.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import { TERMINAL_TAB_ID_PANE_KEY_DELIMITER } from './terminal-tab-id'

export function isValidTerminalTabId(value: string): boolean {
  const fallback = value.length > 0 && !value.includes(TERMINAL_TAB_ID_PANE_KEY_DELIMITER)
  try {
    // Why the catch: both callers validate an id off the wire, so one can carry a
    // lone UTF-16 surrogate — the codec refuses it (it cannot cross into Rust) and
    // the twin answered it without crossing, so the fallback is that same answer.
    // Only the encode rejection is caught; a DispatchCoreError still propagates.
    const answer = tryOrcaDispatch('terminal-tab-id', 'isValidTerminalTabId', value, {
      root: 'tabId'
    })
    return answer === null ? fallback : (answer as boolean)
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return fallback
    }
    throw error
  }
}
