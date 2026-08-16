/**
 * Compares what a worker SAID it changed against what git says it changed —
 * `docs/reference/app-modes.md` §8.4.
 *
 * The highest-signal alert an autonomous fleet can produce. Everything else on
 * the console is the fleet describing itself; a task claiming three modified
 * files where git shows none is the one signal capable of CONTRADICTING an
 * agent. Without it, "completed" is 100% self-attestation.
 *
 * **It degrades to `unknown`, never to `mismatch`.** On a folder workspace there
 * is no git to ask, and an absent answer is not a discrepancy — reporting
 * "mismatch" when the truth is "I could not check" would train a supervisor to
 * ignore the alert.
 *
 * CUT OVER to `orca-policy::task_claim` (dispatch module `task-claim`): the
 * comparison, the path normalization and the summary wording all live in the
 * core. What stays here is the row types and the adapters that decide what
 * crosses.
 *
 * MAIN-ONLY, so there is no pre-ready fallback and no sentinel — and that is
 * checked, not assumed: the sole production caller is
 * `rpc/methods/alab-console.ts` (a main RPC method), and `src/main/index.ts`
 * installs the napi binding on its first import line, before any runtime code
 * runs. `requireOrcaDispatch` is therefore honest here: an unbound seam is a
 * bootstrap-order bug worth a loud throw, and a degraded verdict would be
 * exactly the "I could not check" this module refuses to fake.
 *
 * DECLARED RESIDUALS — measured against the deleted twin on the shipped core.
 * `pnpm parity` can no longer see any of them, because after this cut-over both
 * of its legs are the core, so this header is their only record:
 *
 * 1. An unpaired surrogate ESCAPE inside a claimed path reads U+FFFD in the core
 *    and the unpaired code unit in the twin, so that entry still compares
 *    unequal to git and lands in `missing`. Same verdict, different spelling.
 *    The win is upstream of it: the whole claim used to go silent as
 *    `unreadable-result`, which EXONERATED the audited agent.
 * 2. Corollary, the one direction that loses a contradiction: when git's own
 *    answer for that file also reads U+FFFD (the status parser decodes lossily),
 *    the repaired entry compares EQUAL, so the row reads `match` where the twin
 *    read `mismatch`. Arguably right — it is the same file — but the twin would
 *    have raised it.
 * 3. serde_json stops at 128 nested frames and JSON.parse does not, so a result
 *    carrying a deeper trace reads `unreadable-result` here and as a claim in
 *    the twin (vector case 46).
 * 4. serde_json rejects a numeric literal that overflows f64 (`1e999`) where
 *    JSON.parse yields Infinity and reads on, so one field this decision never
 *    looks at costs the whole verdict (vector case 48).
 *
 * 3 and 4 silence a real alert; both are port bugs the vector already records as
 * `allowDivergence`, carried over here rather than closed.
 *
 * A RAW unpaired code unit cannot reach the adapters below: `result` comes back
 * from the SQLite store and `changedFiles` from the git status parser, both
 * across a UTF-8 napi boundary, so only the six-ASCII escape spelling survives —
 * which is the case the core now repairs. If one ever did arrive, the codec
 * rejects it by field name instead of shipping an undecodable payload.
 */

import { requireOrcaDispatch } from '../../../shared/orca-dispatch-seam'

/** `TaskRow.result` is JSON written by the lifecycle reconciler. */
export type TaskClaim = {
  completedBy: string | null
  filesModified: string[]
}

export type ClaimReconciliation =
  | { verdict: 'unknown'; reason: 'no-git' | 'unreadable-result' | 'not-completed' }
  | {
      verdict: 'match'
      claimed: string[]
    }
  | {
      verdict: 'mismatch'
      claimed: string[]
      /** Claimed but not changed on disk — the alarming direction. */
      missing: string[]
      /** Changed on disk but never claimed — sloppy, not necessarily wrong. */
      unclaimed: string[]
    }

/** One task's claim and git's answer about it — what both core calls read. */
export type TaskClaimInputs = {
  taskStatus: string
  result: string | null
  /** null when there is no git to ask — a folder workspace. */
  changedFiles: string[] | null
}

// The adapters below take `unknown` on purpose: the values arrive from an RPC
// payload and a SQLite row, so the declared types are a claim about the callers,
// not a guarantee about the data. Each one keeps the twin's own answer for the
// off-type value rather than letting the encoder reject the whole payload.

/** Only `'completed'` is ever read, so a non-string status is "not completed". */
function taskStatusOf(taskStatus: unknown): string {
  return typeof taskStatus === 'string' ? taskStatus : ''
}

/** null/undefined mean "no result row was written"; anything else is coerced,
 *  because `JSON.parse` coerced it too. */
function resultOf(result: unknown): string | null {
  return result === null || result === undefined ? null : String(result)
}

/** `null` ONLY for null/absent — an empty array is a real git answer ("nothing
 *  changed"), and collapsing the two is the bug this module exists to prevent.
 *  Entries are coerced rather than dropped: a dropped entry moves git's answer
 *  in both wrong directions at once (a false accusation, and a real mismatch
 *  read as a clean bill of health). */
function changedFilesOf(changedFiles: unknown): string[] | null {
  return Array.isArray(changedFiles) ? changedFiles.map(String) : null
}

function claimInput(args: TaskClaimInputs): TaskClaimInputs {
  return {
    taskStatus: taskStatusOf(args.taskStatus),
    result: resultOf(args.result),
    changedFiles: changedFilesOf(args.changedFiles)
  }
}

/** Tolerates the several shapes `result` has carried; anything else is unknown. */
export function parseTaskClaim(result: string | null): TaskClaim | null {
  return requireOrcaDispatch('task-claim', 'parseTaskClaim', {
    result: resultOf(result)
  }) as TaskClaim | null
}

export function reconcileTaskClaim(args: TaskClaimInputs): ClaimReconciliation {
  return requireOrcaDispatch(
    'task-claim',
    'reconcileTaskClaim',
    claimInput(args)
  ) as ClaimReconciliation
}

/** A one-line summary for the console. Never says "mismatch" for `unknown`.
 *  Takes the CLAIM, not a verdict: the core composes the two, and describing a
 *  hand-built verdict would prove the wording and nothing about the path. */
export function describeTaskClaimReconciliation(args: TaskClaimInputs): string {
  return requireOrcaDispatch('task-claim', 'describeReconciliation', claimInput(args)) as string
}
