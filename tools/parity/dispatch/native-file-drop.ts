// TS dispatch for the native-file-drop parity module. Both ported functions were
// cut over to the Rust core — preload and the renderer sidebar now reach
// `orca_core::native_file_drop` through src/shared/native-file-drop-routing.ts —
// so their TS bodies are gone and this adapter drives the SAME wasm: the vectors'
// recorded goldens keep pinning that surface, and the harness's TS-vs-Rust diff
// degenerates to wasm-vs-binary (napi/wasm entry-point drift still surfaces).
//
// The rest of src/shared/native-file-drop.ts (limits, payload build/validate,
// the wire guard) is unported and has no cases here. `paneLeafId` is likewise
// unported — orca_core's path entry has no such field — so the shim composes it
// in TS on both paths; it is out of this module's scope, not a divergence.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('native-file-drop', fn, JSON.stringify(input ?? null))
  )
}
