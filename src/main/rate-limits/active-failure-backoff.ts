// Logic moved to the Rust orca-provider-backoff core (orca-dispatch); this file
// retains data only. Main drives the Rust port via napi
// (src/main/rust-provider-backoff.ts); there is no renderer/wasm consumer.
// The doubling+clamp decision is proven equivalent to the deleted TS by
// `rust/crates/orca-provider-backoff/parity-corpus.txt` and proven correct by
// that crate's `proofs/ay/bo_*.smt2`.
//
// Base/ceiling are CONSTANTS in the Rust core (and are baked into those proofs),
// not parameters, so they are pinned here as the single TS-side copy: the shim
// rejects any other bounds rather than silently ignoring them. They mirror the
// service's MIN_POLL_MS / DEFAULT_POLL_MS.

/** Wait after the first failure — mirrors `MIN_POLL_MS` (30s). */
export const ACTIVE_FAILURE_REFETCH_BASE_MS = 30 * 1000
/** Ceiling the backoff saturates to — mirrors `DEFAULT_POLL_MS` (15min). */
export const MAX_ACTIVE_FAILURE_REFETCH_MS = 15 * 60 * 1000
