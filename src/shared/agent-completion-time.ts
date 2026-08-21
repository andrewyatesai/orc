import type { AgentStatusEntry } from './agent-status-types'

/** The subset of a hook entry a completion time is derived from. */
export type AgentCompletionSource = Pick<
  AgentStatusEntry,
  'state' | 'stateStartedAt' | 'interrupted'
>

/**
 * When the entry's agent last actually COMPLETED a turn, or null when nothing qualifies.
 * One clock for both the displayed completion age and Smart Sort's Done eligibility, so a row
 * can't rank as freshly done while showing an age past the staleness threshold.
 *
 * A completion is a non-interrupted `done`: its `stateStartedAt`, which same-state tool/prompt
 * pings leave unmoved (they only advance `updatedAt`). Interrupted `done` (Ctrl+C) is not a
 * completion — the user is finished with the turn.
 */
export function agentEntryCompletionAt(entry: AgentCompletionSource): number | null {
  if (entry.state !== 'done' || entry.interrupted === true) {
    return null
  }
  return Number.isFinite(entry.stateStartedAt) ? entry.stateStartedAt : null
}
