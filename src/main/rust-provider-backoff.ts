// Main-process active-window refetch backoff, driven by the Rust
// orca-provider-backoff core via napi (the TS impl was gutted to data).
import { dispatchNumericToRustCore } from './rust-core-dispatch'
import {
  ACTIVE_FAILURE_REFETCH_BASE_MS,
  MAX_ACTIVE_FAILURE_REFETCH_MS
} from './rate-limits/active-failure-backoff'

// Why: the Rust adapter reads the streak as i64 and clamps to u32, so anything
// past this is already the ceiling — clamp here too rather than emit a JSON
// number Rust would reinterpret.
const MAX_DISPATCHABLE_STREAK = 0xffff_ffff

/**
 * Refetch throttle (ms) for a provider with `streak` consecutive failures:
 * `min(baseMs * 2 ** max(0, streak - 1), maxMs)`. Streak 0 and 1 both wait `baseMs`;
 * each further failure doubles the wait until it saturates at `maxMs`.
 *
 * `baseMs`/`maxMs` are kept in the signature (the twin's shape) but are OWNED by
 * the Rust core as constants — see the guard below.
 */
export function activeFailureRefetchThrottleMs(
  streak: number,
  baseMs: number,
  maxMs: number
): number {
  // Why: base/ceiling are compile-time constants in the Rust core (and in its
  // SMT proofs), so other bounds would be silently ignored across the seam — throw.
  if (baseMs !== ACTIVE_FAILURE_REFETCH_BASE_MS || maxMs !== MAX_ACTIVE_FAILURE_REFETCH_MS) {
    throw new Error(
      `activeFailureRefetchThrottleMs: the Rust orca-provider-backoff core pins base=${ACTIVE_FAILURE_REFETCH_BASE_MS}/max=${MAX_ACTIVE_FAILURE_REFETCH_MS}; got base=${baseMs}/max=${maxMs}`
    )
  }
  // Why this stays even though the codec now REJECTS NaN/Infinity: rejecting is
  // a boundary decision, but which backoff a non-finite streak deserves is a
  // domain one — NaN is the base wait, +Infinity the saturating streak. Deleting
  // this would turn "maximum backoff" into a thrown error at the call site, and
  // the Math.trunc is load-bearing regardless (Rust reads the streak as i64, so a
  // fractional streak the codec happily encodes would not decode).
  const safeStreak = Number.isNaN(streak)
    ? 0
    : Math.min(Math.max(0, Math.trunc(streak)), MAX_DISPATCHABLE_STREAK)
  return dispatchNumericToRustCore('provider-backoff', 'activeFailureRefetchThrottleMs', {
    streak: safeStreak
  }) as number
}
