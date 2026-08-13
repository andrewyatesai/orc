// TS dispatch for the provider-backoff parity module. The TS twin
// (src/main/rate-limits/active-failure-backoff.ts) was gutted to data — the Rust
// orca-provider-backoff core is the sole impl, driven by main via napi
// (src/main/rust-provider-backoff.ts) — so this adapter drives the SAME wasm the
// relay runs: the vectors' recorded goldens pin that surface, and the harness's
// TS-vs-Rust diff degenerates to wasm-vs-binary (drift between the two Rust entry
// points still surfaces).
//
// Base/ceiling are constants inside the core (30s / 15min, mirroring
// MIN_POLL_MS / DEFAULT_POLL_MS), so there is nothing left to pin here.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('provider-backoff', fn, JSON.stringify(input ?? null))
  )
}
