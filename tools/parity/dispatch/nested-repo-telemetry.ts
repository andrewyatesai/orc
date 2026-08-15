// TS dispatch for the nested-repo-telemetry parity module. Every function the
// vectors cover was CUT OVER (`src/shared/nested-repo-telemetry.ts` keeps only
// the types, the enum tables, the count cap and the attempt-id entropy edge —
// the Rust orca-core `nested_repo_telemetry` port is the sole implementation,
// reached through the shared dispatch seam from
// src/shared/nested-repo-telemetry-payloads.ts, which serves both the renderer
// builders and main's telemetry-events bucket check), so this adapter drives the
// SAME wasm: the vectors' recorded goldens now pin the production surface, and
// the harness's TS-vs-Rust diff degenerates to wasm-vs-binary (drift between the
// two Rust entry points would still surface here).
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('nested-repo-telemetry', fn, JSON.stringify(input ?? null))
  )
}
