/**
 * Compares what a worker SAID it changed against what git says it changed —
 * `docs/reference/app-modes.md` §8.4.
 *
 * This is the highest-signal alert an autonomous fleet can produce, and nothing
 * computed it before. Everything else on the console is the fleet describing
 * itself; a task claiming three modified files where git shows none is the one
 * signal capable of CONTRADICTING an agent. Without it, "completed" is 100%
 * self-attestation.
 *
 * **It degrades to `unknown`, never to `mismatch`.** On a folder workspace there
 * is no git to ask, and an absent answer is not a discrepancy. Reporting
 * "mismatch" when the truth is "I could not check" would train a supervisor to
 * ignore the alert — which costs more than not having it.
 *
 * Pure: git status is injected, so the comparison is testable without a repo.
 */

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

/** Tolerates the several shapes `result` has carried; anything else is unknown. */
export function parseTaskClaim(result: string | null): TaskClaim | null {
  if (!result) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(result)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const raw = parsed as { completedBy?: unknown; filesModified?: unknown }
    const files = Array.isArray(raw.filesModified)
      ? raw.filesModified.filter((file): file is string => typeof file === 'string')
      : []
    return {
      completedBy: typeof raw.completedBy === 'string' ? raw.completedBy : null,
      filesModified: files
    }
  } catch {
    return null
  }
}

/** Paths arrive from two systems with different conventions; compare shapes. */
function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

export function reconcileTaskClaim(args: {
  taskStatus: string
  result: string | null
  /** null when there is no git to ask — a folder workspace. */
  changedFiles: string[] | null
}): ClaimReconciliation {
  // Only a COMPLETED task makes a claim. A running one has not said anything yet.
  if (args.taskStatus !== 'completed') {
    return { verdict: 'unknown', reason: 'not-completed' }
  }
  const claim = parseTaskClaim(args.result)
  if (!claim) {
    return { verdict: 'unknown', reason: 'unreadable-result' }
  }
  if (args.changedFiles === null) {
    // Folder workspace, or git unavailable. NOT a mismatch.
    return { verdict: 'unknown', reason: 'no-git' }
  }

  const claimed = claim.filesModified.map(normalizePath).filter(Boolean)
  const actual = new Set(args.changedFiles.map(normalizePath).filter(Boolean))
  const claimedSet = new Set(claimed)

  const missing = claimed.filter((file) => !actual.has(file))
  const unclaimed = [...actual].filter((file) => !claimedSet.has(file))

  if (missing.length === 0 && unclaimed.length === 0) {
    return { verdict: 'match', claimed }
  }
  return { verdict: 'mismatch', claimed, missing, unclaimed }
}

/** A one-line summary for the console. Never says "mismatch" for `unknown`. */
export function describeReconciliation(reconciliation: ClaimReconciliation): string {
  switch (reconciliation.verdict) {
    case 'match':
      return `${reconciliation.claimed.length} file(s) claimed and changed`
    case 'mismatch':
      return reconciliation.missing.length > 0
        ? `claimed ${reconciliation.missing.length} file(s) git does not show as changed`
        : `changed ${reconciliation.unclaimed.length} file(s) it did not claim`
    case 'unknown':
      return reconciliation.reason === 'no-git'
        ? 'cannot check on a folder workspace'
        : 'nothing to check yet'
  }
}
