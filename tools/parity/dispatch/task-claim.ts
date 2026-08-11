// TS dispatch for the task-claim parity module: drives the LIVE
// src/main/runtime/orchestration/task-claim-reconciliation.ts against the Rust
// port (orca-policy::task_claim).
//
// This is the fleet's only CONTRADICTING signal — everything else on the
// console is the fleet describing itself — so a drift between the two
// implementations is not cosmetic. The direction that matters most is the one
// the module header names: it must degrade to `unknown`, never to `mismatch`.
// `changedFiles: null` (a folder workspace, or a git status read that failed)
// is therefore carried through untouched rather than defaulted to `[]`, which
// would silently turn "I could not check" into "you lied".

import {
  describeReconciliation,
  parseTaskClaim,
  reconcileTaskClaim
} from '../../../src/main/runtime/orchestration/task-claim-reconciliation'

/** JSON `null` and an absent key both mean "no result row was written". */
function resultOf(args: Record<string, unknown>): string | null {
  return args.result === null || args.result === undefined ? null : String(args.result)
}

/**
 * `null` ONLY for null/absent. An empty array is a real git answer ("nothing
 * changed") and collapsing the two is exactly the bug this module exists to
 * prevent.
 */
function changedFilesOf(args: Record<string, unknown>): string[] | null {
  return Array.isArray(args.changedFiles) ? args.changedFiles.map(String) : null
}

export function dispatch(fn: string, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>
  const reconcile = () =>
    reconcileTaskClaim({
      taskStatus: String(args.taskStatus ?? ''),
      result: resultOf(args),
      changedFiles: changedFilesOf(args)
    })
  switch (fn) {
    case 'parseTaskClaim':
      return parseTaskClaim(resultOf(args))
    case 'reconcileTaskClaim':
      return reconcile()
    // Composed through `reconcile`, which is how alab-console.ts calls it — a
    // hand-built verdict would prove the formatter and nothing about the path.
    case 'describeReconciliation':
      return describeReconciliation(reconcile())
    default:
      return { __parity_error__: `unknown function ${fn}` }
  }
}
