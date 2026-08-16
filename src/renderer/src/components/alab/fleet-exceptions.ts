/**
 * The exceptions queue's TYPES AND DATA — `docs/reference/app-modes.md` §8.3.
 *
 * The reducer itself was ported to `orca_core::fleet_exceptions` and is reached
 * through `@/lib/git-wasm/fleet-exception-queue`; what stays here is everything
 * the renderer reads as data rather than calls as logic. `ExceptionsQueue`
 * renders `kind` straight out of a row, the shim's pre-ready fallback ranks with
 * `EXCEPTION_SEVERITY`, and the parity corpus compares `EXCEPTION_SOURCE_STATUS`
 * against the Rust copy so the two tables cannot drift apart.
 *
 * The collapse rule lives in one place because it is the part that can be wrong
 * in a way nobody notices: a deterministic failure emits escalation → retry →
 * escalation → retry → escalation → circuit_broken in about ten seconds.
 * Rendered raw that is six rows describing one problem, and the queue is least
 * readable exactly when it matters most.
 */

/** §8.3's six sources. `kind` is the badge, and it is also the severity key. */
export type FleetExceptionKind =
  | 'gate'
  | 'escalation'
  | 'circuit-broken'
  | 'lifecycle-rejected'
  | 'attention'
  | 'unanswered-ask'

export type FleetException = {
  /** The collapse key. Every source must resolve one, or its rows cannot be
   *  merged with the other five and the task appears twice. */
  taskId: string
  kind: FleetExceptionKind
  summary: string
  workerHandle: string | null
  /** How many raw rows collapsed into this one — the retry counter a supervisor
   *  reads as "this has failed repeatedly", not "this happened once". */
  attempts: number
  /** ISO timestamp of the most severe row, used only for ordering. */
  at: string
}

/**
 * Most severe first. `circuit-broken` outranks `escalation` because the breaker
 * means the fleet has STOPPED retrying — nothing further happens without a
 * human — whereas an escalation may still resolve itself on the next attempt.
 * `gate` is highest because it is the one state where a worker is actively
 * blocked on this specific person.
 *
 * Exported because the collapse shim ranks with it before the wasm core is
 * ready; `orca_core::fleet_exceptions::severity` is the same table in Rust and
 * the parity corpus pins the two together.
 */
export const EXCEPTION_SEVERITY: Record<FleetExceptionKind, number> = {
  gate: 6,
  'circuit-broken': 5,
  'unanswered-ask': 4,
  'lifecycle-rejected': 3,
  escalation: 2,
  attention: 1
}

/**
 * Which of §8.3's six sources this build actually reads.
 *
 * Stated as data rather than prose so the console can say what it cannot see.
 * A supervisor who believes the queue covers all six, when it covers one, will
 * read an empty queue as "nothing is wrong" — which is precisely the failure
 * the queue exists to prevent.
 *
 * KEY ORDER IS LOAD-BEARING: `unwiredExceptionSources` reports in `Object.keys`
 * order, which `EXCEPTION_SOURCE_ORDER` mirrors in Rust.
 */
export const EXCEPTION_SOURCE_STATUS: Record<FleetExceptionKind, 'wired' | 'not-yet'> = {
  // Real per-task rows from orchestration.gateList — NOT runList's per-run
  // count, which cannot be decomposed back into the tasks it counted.
  gate: 'wired',
  escalation: 'wired',
  'circuit-broken': 'wired',
  // Stale-heartbeat detection: the only thing that can tell a wedged worker from
  // a finished one, since agent-hook status decays a non-done entry to idle.
  attention: 'wired',
  // Detected by the payload marker the Rust store stamps, not by message type —
  // a rejection is a worker_done/heartbeat that Orca refused.
  'lifecycle-rejected': 'wired',
  // An unread decision_gate message with no reply on its thread.
  'unanswered-ask': 'wired'
}
