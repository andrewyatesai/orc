// TS dispatch for the git-push-target parity module. The shared TS impl was
// DELETED (`src/shared/git-push-target-validation.ts` keeps only the rule
// constants — the Rust orca-core `git_push_target` port is the sole
// implementation: main IPC + the relay via src/shared/git-push-target-shape.ts
// on the orca-dispatch seam, src/main/git/* via the napi
// validateGitPushTargetRules export), so this adapter drives the SAME wasm: the
// vectors' recorded goldens now pin the production surface, and the harness's
// TS-vs-Rust diff degenerates to wasm-vs-binary (drift between the two Rust
// entry points would still surface here).
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('git-push-target', fn, JSON.stringify(input ?? null))
  )
}
