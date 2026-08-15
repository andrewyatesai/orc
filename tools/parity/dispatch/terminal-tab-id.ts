// TS dispatch for the terminal-tab-id parity module. The shared TS impl was
// DELETED (`src/shared/terminal-tab-id.ts` keeps only the pane-key delimiter — the
// Rust orca-core `terminal_tab_id` port is the sole implementation: renderer via
// src/renderer/src/lib/git-wasm/terminal-tab-id.ts, main via
// src/main/rust-terminal-tab-id.ts, tree-agnostic src/shared consumers via
// src/shared/terminal-tab-id-validity.ts), so this adapter drives the SAME wasm:
// the vectors' recorded goldens now pin the production surface, and the harness's
// TS-vs-Rust diff degenerates to wasm-vs-binary (drift between the two Rust entry
// points would still surface here).
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('terminal-tab-id', fn, JSON.stringify(input ?? null))
  )
}
