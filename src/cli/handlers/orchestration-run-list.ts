import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalNonNegativeIntegerFlag, getOptionalPositiveIntegerFlag } from '../flags'

type RunTaskCounters = {
  completed: number
  failed: number
  blocked: number
  dispatched: number
  readyOrPending: number
  total: number
}

type RunListRow = {
  id: string
  spec: string
  status: string
  coordinator_handle: string
  created_at: string
  live: boolean
  tasks: RunTaskCounters
  pendingGates: number
}

type RunListResult = {
  runs: RunListRow[]
  count: number
  limit: number
  offset: number
  hasMore: boolean
}

// Why split, never a fraction: `checkConvergence` counts failed tasks toward
// "all done", so `6/9` would report two failures as progress (app-modes §8.3).
// Zero counts still print so a missing segment never reads as "none reported".
function formatCounters(tasks: RunTaskCounters, pendingGates: number): string {
  const segments = [
    `${tasks.completed} done`,
    `${tasks.failed} failed`,
    `${tasks.blocked} blocked`,
    `${tasks.dispatched} dispatched`,
    `${tasks.readyOrPending} queued`
  ]
  if (pendingGates > 0) {
    segments.push(`${pendingGates} gate${pendingGates === 1 ? '' : 's'} pending`)
  }
  return segments.join(' · ')
}

// Why the liveness suffix: a run row still says `running` after a restart killed
// its coordinator, and that row will never move again on its own.
function formatStatus(run: RunListRow): string {
  if (run.status !== 'running') {
    return run.status
  }
  return run.live ? 'running, live' : 'running, no live loop'
}

function formatRunListRows(result: RunListResult): string {
  if (result.count === 0) {
    return 'No runs.'
  }
  const lines = result.runs.map(
    (run) =>
      `${run.id} [${formatStatus(run)}] coord=${run.coordinator_handle} created=${run.created_at}\n` +
      `  ${formatCounters(run.tasks, run.pendingGates)}`
  )
  if (result.hasMore) {
    lines.push(`(more runs — rerun with --offset ${result.offset + result.count})`)
  }
  return lines.join('\n')
}

/** `orca orchestration run-list` — bounded run history, newest first. */
export const runOrchestrationRunList: CommandHandler = async ({ flags, client, json }) => {
  const result = await client.call<RunListResult>('orchestration.runList', {
    limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
    offset: getOptionalNonNegativeIntegerFlag(flags, 'offset')
  })
  printResult(result, json, formatRunListRows)
}
