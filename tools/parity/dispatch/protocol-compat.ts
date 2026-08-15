// TS dispatch for the protocol-compat parity module. The shared TS impl was
// DELETED (`src/shared/protocol-compat.ts` keeps only the verdict types — the
// Rust orca-core `protocol_compat` port is the sole implementation, reached from
// the renderer, the CLI and src/shared alike through
// src/shared/protocol-compat-verdict.ts on the orca-dispatch seam), so this
// adapter drives the SAME wasm: the vectors' recorded goldens now pin the
// production surface, and the harness's TS-vs-Rust diff degenerates to
// wasm-vs-binary (drift between the two Rust entry points would still surface).
//
// The shim answers a version that is not a safe integer locally instead of
// dispatching (serde's `as_i64` reads it as absent, i.e. protocol 0); every
// vector here is in-contract, so that guard is out of this module's scope and is
// pinned by protocol-compat-verdict.test.ts instead.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('protocol-compat', fn, JSON.stringify(input ?? null))
  )
}
