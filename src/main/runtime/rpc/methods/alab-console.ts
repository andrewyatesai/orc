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
import { getStatus } from '../../../git/status'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id-parsing'
import {
  describeTaskClaimReconciliation,
  reconcileTaskClaim
} from '../../orchestration/task-claim-reconciliation'
import { getCoordinatorRunWorktreeId, isCoordinatorRunLive } from './orchestration-gates'
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
    handler: async (params, { runtime }) => {
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

      // Status is read ONCE per worktree, not once per task: a run with fifty
      // tasks would otherwise spawn fifty git subprocesses every poll tick.
      const changedByWorktree = new Map<string, string[] | null>()
      for (const run of runs) {
        const worktreeId = getCoordinatorRunWorktreeId(run.id) ?? null
        const worktreePath = worktreeId
          ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null)
          : null
        if (!worktreePath) {
          // No worktree we can resolve: honestly unknown, not a mismatch.
          changedByWorktree.set(run.id, null)
          continue
        }
        try {
          const status = await getStatus(worktreePath)
          changedByWorktree.set(
            run.id,
            status.entries.map((entry) => entry.path)
          )
        } catch {
          // A folder workspace with no git, or an unreadable repo. Both mean
          // "cannot check", which must never present as a discrepancy.
          changedByWorktree.set(run.id, null)
        }
      }
      const changedFilesForRun = (runId: string | null): string[] | null =>
        runId ? (changedByWorktree.get(runId) ?? null) : null

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

      // 4, 5 & 6. Escalations, lifecycle rejections and unanswered asks.
      //
      // MessageType has no `lifecycle_rejected` or `question` member, so an
      // earlier version left both unwired. That was wrong about the data rather
      // than about the design: a rejection is a `worker_done`/`heartbeat` whose
      // payload the Rust store stamped with `_orcaLifecycleRejection`, and an
      // unanswered ask is an unread `decision_gate` message that has no reply on
      // its thread. Both are detectable without inventing a classification.
      const inbox: MessageRow[] = db.getInbox(limit * 8)
      const repliedThreads = new Set(
        inbox
          .filter((message) => message.type !== 'decision_gate' && message.thread_id)
          .map((message) => message.thread_id as string)
      )
      for (const message of inbox) {
        const rejection = lifecycleRejectionReason(message)
        const kind: ConsoleException['kind'] | null = rejection
          ? 'lifecycle-rejected'
          : message.type === 'escalation'
            ? 'escalation'
            : // An ask is only an EXCEPTION while nobody has answered it. A read
              // message, or one whose thread carries a reply, is not waiting.
              message.type === 'decision_gate' &&
                message.read === 0 &&
                !(message.thread_id && repliedThreads.has(message.thread_id))
              ? 'unanswered-ask'
              : null
        if (!kind) {
          continue
        }
        exceptions.push({
          // A message may not name a task; keying on its own id keeps it visible
          // instead of collapsing unrelated messages into one row.
          taskId: extractTaskId(message) ?? `message:${message.id}`,
          kind,
          summary: rejection ?? message.subject ?? message.body.slice(0, 120),
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
        // §8.4's claim check, against REAL git status. `changedFiles` is null
        // only when there is genuinely no git to ask — a folder workspace, or a
        // worktree whose status read failed — and null degrades to `unknown`,
        // never to `mismatch`. That distinction is the whole reason a supervisor
        // can trust this row.
        reconciliations: tasks.map((task) => {
          // Both calls read the same claim: the core composes the summary
          // through its own reconcile, so it cannot describe a different row.
          const claim = {
            taskStatus: task.status,
            result: task.result,
            changedFiles: changedFilesForRun(task.run_id)
          }
          return {
            taskId: task.id,
            verdict: reconcileTaskClaim(claim).verdict,
            summary: describeTaskClaimReconciliation(claim)
          }
        }),
        takenAt: now
      }
    }
  })
]

/**
 * The marker `convert_lifecycle_message_to_rejection` stamps into the payload
 * (`orchestration.rs`). Its presence — not the message TYPE — is what makes a
 * `worker_done` a rejection, which is why type-only classification missed it.
 */
function lifecycleRejectionReason(message: MessageRow): string | null {
  if (!message.payload) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(message.payload)
    const marker = (parsed as { _orcaLifecycleRejection?: unknown })?._orcaLifecycleRejection
    if (typeof marker !== 'object' || marker === null) {
      return null
    }
    const reason = (marker as { reason?: unknown }).reason
    return typeof reason === 'string' && reason.length > 0 ? reason : 'Rejected by Orca'
  } catch {
    return null
  }
}

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
