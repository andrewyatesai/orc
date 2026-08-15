// TS dispatch for the git-publish-target-status parity module. The shared TS impl
// was gutted (the Rust push_target / publish_target_status cores are the sole
// impl — main drives them via napi, the relay via wasm, the renderer through
// src/renderer/src/lib/git-wasm/git-publish-target-status.ts), so this adapter
// drives that SAME wasm: the vectors' recorded goldens now pin that surface, and
// the harness's TS-vs-Rust diff degenerates to wasm-vs-binary.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('git-publish-target-status', fn, JSON.stringify(input ?? null))
  )
}
