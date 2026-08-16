// TS dispatch for the task-claim parity module. The TS twin
// (src/main/runtime/orchestration/task-claim-reconciliation.ts) is cut over to
// the Rust core via the orcaDispatch aggregate — main-only, so requireOrcaDispatch
// with no fallback — and this adapter drives that same napi binding. The
// harness's TS-vs-Rust diff therefore degenerates to napi-vs-binary with the
// vector goldens as the absolute pin. Requires the built addon, like the
// napi-parity suite.
//
// What the diff can no longer see, and where it went: the twin's four measured
// divergences (the U+FFFD path repair and its match/mismatch corollary, the
// 128-frame nesting cap, the f64-overflow literal) are declared in the shim's
// header and pinned by its tests, because both legs here are now the core.
//
// The vectors' own adapter cases stay meaningful: `result` as a one-element
// array and non-string `changedFiles` entries are COERCED, never dropped —
// dropping one moves git's answer in both wrong directions at once.
import { requireRustGitBinding } from '../../../src/main/daemon/rust-git-addon'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(requireRustGitBinding().orcaDispatch('task-claim', fn, JSON.stringify(input)))
}
