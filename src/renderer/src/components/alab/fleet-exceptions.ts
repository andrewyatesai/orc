/**
 * The exceptions reducer — `docs/reference/app-modes.md` §8.3.
 *
 * Pure, and separate from the component, because the collapse rule is the part
 * that can be wrong in a way nobody notices: a deterministic failure emits
 * escalation → retry → escalation → retry → escalation → circuit_broken in
 * about ten seconds. Rendered raw that is six rows describing one problem, and
 * the queue is least readable exactly when it matters most.
 *
 * **Collapse happens BEFORE ordering.** Ordering first and de-duplicating after
 * would keep whichever row happened to sort first rather than the most severe
 * one, so a task showing `circuit_broken` could be represented by its earliest
 * `escalation`.
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
 */
const SEVERITY: Record<FleetExceptionKind, number> = {
  gate: 6,
  'circuit-broken': 5,
  'unanswered-ask': 4,
  'lifecycle-rejected': 3,
  escalation: 2,
  attention: 1
}

/**
 * One row per task: the most severe kind wins, and `attempts` counts everything
 * that collapsed into it.
 *
 * Ordering is severity, then recency. Not recency alone — a circuit-broken task
 * from an hour ago still outranks an escalation from a minute ago, because the
 * older one is the one that will never resolve itself.
 */
export function collapseExceptionsByTask(raw: readonly FleetException[]): FleetException[] {
  const byTask = new Map<string, FleetException>()
  for (const exception of raw) {
    const existing = byTask.get(exception.taskId)
    if (!existing) {
      byTask.set(exception.taskId, { ...exception })
      continue
    }
    // Strictly-greater would keep the FIRST of two equal-severity rows, so two
    // escalations at 10:00 and 12:00 would leave the task showing 10:00 — and
    // then sorting by that stale timestamp ranks it below fresher, less urgent
    // work. On a tie the newer row wins, because it is the current state of the
    // task and carries the current summary and worker.
    const higher = SEVERITY[exception.kind] > SEVERITY[existing.kind]
    const sameSeverityButNewer =
      SEVERITY[exception.kind] === SEVERITY[existing.kind] && exception.at > existing.at
    const winner = higher || sameSeverityButNewer ? exception : existing
    byTask.set(exception.taskId, {
      ...winner,
      // Attempts survive the merge regardless of which row won: the count is
      // about the task, not about the winning row.
      attempts: existing.attempts + exception.attempts,
      // And so does recency — a lower-severity but newer row still means the
      // task moved, which is what the sort's tiebreak needs to know.
      at: exception.at > existing.at ? exception.at : existing.at
    })
  }
  return [...byTask.values()].sort((left, right) => {
    const bySeverity = SEVERITY[right.kind] - SEVERITY[left.kind]
    return bySeverity !== 0 ? bySeverity : right.at.localeCompare(left.at)
  })
}

/**
 * Which of §8.3's six sources this build actually reads.
 *
 * Stated as data rather than prose so the console can say what it cannot see.
 * A supervisor who believes the queue covers all six, when it covers one, will
 * read an empty queue as "nothing is wrong" — which is precisely the failure
 * the queue exists to prevent.
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

export function unwiredExceptionSources(): FleetExceptionKind[] {
  return (Object.keys(EXCEPTION_SOURCE_STATUS) as FleetExceptionKind[]).filter(
    (kind) => EXCEPTION_SOURCE_STATUS[kind] === 'not-yet'
  )
}
