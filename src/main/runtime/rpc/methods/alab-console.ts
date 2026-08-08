/**
 * `alab.consoleSnapshot` — the whole supervisory console in one read.
 *
 * Assembled SERVER-SIDE on purpose. The alternative was the renderer issuing six
 * queries per tick to build §8.3's exceptions queue, which would multiply the
 * console's share of a long-poll budget the runtime caps and the fleet's own
 * workers compete for. One call also means the panels cannot disagree: they
 * render one snapshot taken at one instant, rather than six that arrived at
 * different times.
 *
 * It is a READ. Nothing here resolves a gate, marks a message read, or mutates
 * a row — a console that changed state by being looked at would make the fleet's
 * behaviour depend on whether a human happened to be watching.
 */
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { countRunTasks } from '../../orchestration/run-progress'
import {
  describeReconciliation,
  reconcileTaskClaim
} from '../../orchestration/task-claim-reconciliation'
import { isCoordinatorRunLive } from './orchestration-gates'
import type { DispatchContextRow, MessageRow, TaskRow } from '../../orchestration/types'

/** §8.3's six sources, as one row shape. */
export type ConsoleException = {
  taskId: string
  kind:
    | 'gate'
    | 'escalation'
    | 'circuit-broken'
    | 'lifecycle-rejected'
    | 'attention'
    | 'unanswered-ask'
  summary: string
  workerHandle: string | null
  attempts: number
  at: string
}

const ConsoleSnapshotParams = z.object({
  limit: z.number().int().min(1).max(200).optional()
})

/** A dispatch is stale when nothing has been heard from it for this long. The
 *  design's own hang detector uses ten minutes; matching it keeps the console
 *  and the coordinator's log telling the same story. */
const STALE_HEARTBEAT_MS = 10 * 60_000

function taskLabel(task: TaskRow | undefined, fallback: string): string {
  return task?.task_title || task?.display_name || task?.spec?.slice(0, 120) || fallback
}

export const ALAB_CONSOLE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'alab.consoleSnapshot',
    params: ConsoleSnapshotParams,
    handler: (params, { runtime }) => {
      runtime.assertFleetVerbEnabled('alab.consoleSnapshot')
      const db = runtime.getOrchestrationDb()
      const limit = params.limit ?? 50
      const now = Date.now()

      const runs = db.runs.list({ limit, offset: 0 }).map((run) => ({
        ...run,
        live: isCoordinatorRunLive(run.id),
        tasks: countRunTasks(db.listTasks({ runId: run.id })),
        pendingGates: db.listGates({ runId: run.id, status: 'pending' }).length
      }))

      const tasks = db.listTasks()
      const taskById = new Map(tasks.map((task) => [task.id, task]))
      const dispatchByTask = new Map<string, DispatchContextRow>()
      for (const task of tasks) {
        const dispatch = db.getDispatchContext(task.id)
        if (dispatch) {
          dispatchByTask.set(task.id, dispatch)
        }
      }

      const exceptions: ConsoleException[] = []

      // 1. Pending gates — the only state blocking on a specific human.
      for (const gate of db.listGates({ status: 'pending' })) {
        exceptions.push({
          taskId: gate.task_id,
          kind: 'gate',
          summary: gate.question || taskLabel(taskById.get(gate.task_id), 'A worker is waiting.'),
          workerHandle: dispatchByTask.get(gate.task_id)?.assignee_handle ?? null,
          attempts: 1,
          at: gate.created_at
        })
      }

      // 2 & 3. Circuit-broken dispatches, and stale ones. `failure_count` is the
      // retry counter a supervisor reads as "this keeps failing".
      for (const [taskId, dispatch] of dispatchByTask) {
        if (dispatch.status === 'circuit_broken') {
          exceptions.push({
            taskId,
            kind: 'circuit-broken',
            summary: dispatch.last_failure || taskLabel(taskById.get(taskId), 'Stopped retrying.'),
            workerHandle: dispatch.assignee_handle,
            attempts: Math.max(1, dispatch.failure_count),
            at: dispatch.completed_at ?? dispatch.created_at
          })
          continue
        }
        // Attention: dispatched, but silent. Agent-hook status alone cannot tell
        // wedged from finished — a non-done entry decays to idle at 30 minutes —
        // so the heartbeat is the only thing that can.
        const heartbeat = dispatch.last_heartbeat_at ?? dispatch.dispatched_at
        if (
          dispatch.status === 'dispatched' &&
          heartbeat &&
          now - Date.parse(heartbeat) > STALE_HEARTBEAT_MS
        ) {
          exceptions.push({
            taskId,
            kind: 'attention',
            summary: taskLabel(taskById.get(taskId), 'No heartbeat.'),
            workerHandle: dispatch.assignee_handle,
            attempts: Math.max(1, dispatch.failure_count),
            at: heartbeat
          })
        }
      }

      // 4. Escalations. NOT lifecycle rejections or unanswered asks: MessageType
      // has no member for either (`lifecycle_rejected` and `question` do not
      // exist), so wiring them would mean inventing a classification the data
      // cannot support. They stay marked not-yet in EXCEPTION_SOURCE_STATUS, and
      // the console says so rather than implying six-source coverage.
      const inbox: MessageRow[] = db.getInbox(limit * 4)
      for (const message of inbox) {
        if (message.type !== 'escalation') {
          continue
        }
        exceptions.push({
          // A message may not name a task; keying on its own id keeps it visible
          // instead of collapsing unrelated messages into one row.
          taskId: extractTaskId(message) ?? `message:${message.id}`,
          kind: 'escalation',
          summary: message.subject || message.body.slice(0, 120),
          workerHandle: message.from_handle,
          attempts: 1,
          at: message.created_at
        })
      }

      return {
        runs,
        exceptions,
        // Dispatch detail for TaskDetail and the fleet board's liveness column.
        dispatches: [...dispatchByTask.values()],
        tasks,
        // §8.4's claim check. `changedFiles: null` because this runtime has no
        // worktree bound to a task row — so every verdict is honestly `unknown`
        // rather than a fabricated match. Wiring real git status per task's
        // worktree is the remaining half, and it must keep degrading to unknown
        // on folder workspaces.
        reconciliations: tasks.map((task) => {
          const verdict = reconcileTaskClaim({
            taskStatus: task.status,
            result: task.result,
            changedFiles: null
          })
          return {
            taskId: task.id,
            verdict: verdict.verdict,
            summary: describeReconciliation(verdict)
          }
        }),
        takenAt: now
      }
    }
  })
]

/** Payloads carry a taskId when the sender knew one; there is no column for it. */
function extractTaskId(message: MessageRow): string | null {
  if (!message.payload) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(message.payload)
    const taskId = (parsed as { taskId?: unknown })?.taskId
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : null
  } catch {
    return null
  }
}
