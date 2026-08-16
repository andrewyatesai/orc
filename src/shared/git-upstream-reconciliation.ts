// The two upstream-reconciliation predicates on the Rust
// `orca_core::git_upstream_status` core. They answer the same question from two
// sides — a diverged branch reconciles with a lease-protected force push, a
// behind-only branch with a pure fast-forward — so they share one shim.
//
// This sits on `orca-dispatch-seam` rather than in a surface binding directory
// because `src/shared` itself calls them: `source-control-primary-action-decision.ts`
// and `source-control-create-review-intent.ts` derive the Source Control primary
// action and the Create-Review eligibility, and those run in the renderer (wasm
// at ready), under the SSH relay, and in mobile's Metro bundle — which never
// binds the seam at all.
//
// PRE-READY CONTRACT — `parity` x2, and it is FORCED, not chosen:
//  * Both answers pick a DESTRUCTIVE git command. `shouldForcePushWithLeaseForUpstream`
//    routes `editor.ts` syncBranch to `git push --force-with-lease` instead of
//    `git pull`, and `SourceControl.tsx` handlePrimaryClick / runCompoundCommitAction
//    to the `force_push` action; `isBehindOnlyUpstream` lets Create PR run
//    `fast_forward` unattended (`SourceControl.tsx`, `source-control-create-pr-intent-flow.ts`).
//    Neither boolean is a safe direction: `false` on the first re-merges the
//    stale patch-equivalent commits the lease push exists to replace, `true`
//    force-pushes; `false` on the second dead-ends Create PR at "blocked",
//    `true` fast-forwards a branch that may not be behind-only.
//  * No sentinel has anywhere to live. Both return types are total booleans read
//    inside `if` and `&&`, and mobile + the preload never bind the seam, so a
//    signal would be their PERMANENT answer rather than a boot-window one.
// So each fallback recomputes the deleted twin's body, which makes pre-ready
// equal ready for every input.
//
// THE COUNTER GUARD, and it is measured rather than defensive. `parse_status`
// reads `ahead`/`behind` out of the payload; the SHIPPED `orca_git_wasm_bg.wasm`
// and `orca_node.node` (both built 17:24, before the 17:32 routing commit
// 25d68c0562) still do it with serde `as_i64().unwrap_or(0)`, which reads
// ABSENT, `null`, `"0"`, `0.5` and anything past i64 as a real ZERO. The twin's
// `ahead === 0` is strict and its `behind > 0` COERCES, so those inputs answer
// differently on the two legs — `{hasUpstream: true, behind: 4}` is the twin's
// false against the shipped core's TRUE, on the predicate that decides whether
// Create PR fast-forwards, and an upstream status arrives from a peer runtime
// over SSH/relay as an unvalidated cast (`unwrapRuntimeRpcResult` is not a
// schema). A counter that is not a safe integer therefore never crosses; it is
// answered from the same local body the unbound seam uses. `git-upstream-reconciliation.test.ts`
// pins both halves — the twin's answer AND that the raw shipped core disagrees —
// so once the blobs are rebuilt onto the f64 core the second half turns red and
// the guard is re-derived instead of outliving its reason.
import type { GitUpstreamStatus } from './git-status-types'
import { tryOrcaDispatch } from './orca-dispatch-seam'

const GIT_UPSTREAM_STATUS = 'git-upstream-status'

/** The deleted twin's body, verbatim. */
function legacyShouldForcePushWithLeaseForUpstream(
  status: GitUpstreamStatus | undefined
): boolean {
  return (
    status?.hasUpstream === true &&
    status.ahead > 0 &&
    status.behind > 0 &&
    status.behindCommitsArePatchEquivalent === true
  )
}

/** The deleted twin's body, verbatim. */
function legacyIsBehindOnlyUpstream(status: GitUpstreamStatus | undefined): boolean {
  return status?.hasUpstream === true && status.ahead === 0 && status.behind > 0
}

/** A counter both cores read back as the number the twin compared. Excludes -0,
 *  which the codec refuses outright, and everything the shipped `as_i64` silently
 *  reads as 0 (absent, null, a string, a fraction, past 2^53). */
function isCoreReadableCounter(value: unknown): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0)
}

/** `null` = the seam is unbound, or the status is outside the class the core
 *  reads the twin's way — answer from the twin's body. Unambiguous: both arms
 *  answer a boolean, never null.
 *
 *  Only the four fields the core reads cross, each already reduced to what its
 *  adapter reads: serde `as_bool()` is `Some(true)` for a literal `true` and
 *  nothing else, which is the twin's `=== true` exactly, and both counters are
 *  guarded safe integers. That also keeps `upstreamName` off the payload — a ref
 *  name lifted off the relay wire can hold an unpaired UTF-16 surrogate, and on
 *  a field the core never reads for these two predicates it could only refuse
 *  the encode and push a real answer onto the fallback. With the guard in place
 *  the payload is two booleans and two finite integers, so `encodeDispatchPayload`
 *  has nothing left to reject and a `DispatchCoreError` still propagates. */
function dispatchUpstreamPredicate(
  fn: string,
  status: GitUpstreamStatus | undefined
): boolean | null {
  // Read each field once, so the bound and unbound paths observe the same value.
  const ahead: unknown = status?.ahead
  const behind: unknown = status?.behind
  if (!isCoreReadableCounter(ahead) || !isCoreReadableCounter(behind)) {
    return null
  }
  const payload = {
    hasUpstream: status?.hasUpstream === true,
    ahead: ahead as number,
    behind: behind as number,
    behindCommitsArePatchEquivalent: status?.behindCommitsArePatchEquivalent === true
  }
  return tryOrcaDispatch(GIT_UPSTREAM_STATUS, fn, payload, { root: 'status' }) as boolean | null
}

/**
 * True when the branch has diverged from its upstream but the behind commits are
 * older patch-equivalent copies of the local ones — pulling them would reintroduce
 * stale history, so a lease-protected force push is the correct reconciliation.
 */
export function shouldForcePushWithLeaseForUpstream(
  status: GitUpstreamStatus | undefined
): boolean {
  const answer = dispatchUpstreamPredicate('shouldForcePushWithLeaseForUpstream', status)
  return answer === null ? legacyShouldForcePushWithLeaseForUpstream(status) : answer
}

/**
 * True when the branch tracks an upstream and is purely behind it. The only
 * auto-prepare case Create PR can settle with a pure fast-forward — there are no
 * local unique commits to reconcile. Eligibility and the intent remote-step
 * resolver share this predicate so the button and the one-click flow never
 * disagree on what "behind-only" means.
 */
export function isBehindOnlyUpstream(status: GitUpstreamStatus | undefined): boolean {
  const answer = dispatchUpstreamPredicate('isBehindOnlyUpstream', status)
  return answer === null ? legacyIsBehindOnlyUpstream(status) : answer
}
