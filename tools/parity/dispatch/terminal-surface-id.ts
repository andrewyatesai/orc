// TS dispatch for the terminal-surface-id parity module. The shared TS impl was
// gutted to its two id constants (the Rust orca_core::terminal_surface_id core is
// the sole impl — the renderer reaches it through
// src/renderer/src/lib/git-wasm/terminal-surface-id.ts), so this adapter drives
// the SAME wasm: the vectors' recorded goldens now pin that surface, and the
// harness's TS-vs-Rust diff degenerates to wasm-vs-binary.
//
// The `web-terminal-%zz` case keeps its `allowDivergence` note for the record,
// but it no longer trips here — the twin that returned the full tabId on a
// malformed decode is gone. That difference is now pinned where it is still
// observable: the shim's pre-ready fallback, in
// src/renderer/src/lib/git-wasm/terminal-surface-id-pre-ready.test.ts and as the
// `divergence` row in shim-pre-ready-contract.test.ts.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('terminal-surface-id', fn, JSON.stringify(input ?? null))
  )
}
