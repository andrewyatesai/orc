import { OrchestrationQuestionStore } from './db-questions'
import { generateId } from './orchestration-store-bridge'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import type { TaskRow, TaskStatus } from './types'

// The join shape returned by listTasksWithDispatch: a task row plus the active
// dispatch's assignee/id (or null when the task has no live dispatch).
type TaskWithDispatchRow = TaskRow & { assignee_handle: string | null; dispatch_id: string | null }

type TaskFilter = { status?: TaskStatus; ready?: boolean; runId?: string }

// The store has one status predicate, so `ready: true` collapses onto it.
function statusFilter(filter?: TaskFilter): TaskStatus | undefined {
  return filter?.ready ? 'ready' : filter?.status
}

export class OrchestrationTaskStore extends OrchestrationQuestionStore {
  createTask(task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
    runId?: string
  }): TaskRow {
    const runId = task.runId ?? ORCHESTRATION_LEGACY_RUN_ID
    // The UTF-16-aware label derivation stays in JS; the resolved strings are
    // passed to the store so Rust needs no port of it.
    const display = buildOrchestrationTaskDisplayMetadata({
      spec: task.spec,
      taskTitle: task.taskTitle,
      displayName: task.displayName
    })
    return rowFromJson<TaskRow>(
      this.store.createTask(
        generateId('task'),
        task.spec,
        task.parentId ?? null,
        task.deps ?? [],
        task.createdByTerminalHandle ?? null,
        display.taskTitle || null,
        display.displayName || null,
        runId
      )
    )
  }

  getTask(id: string): TaskRow | undefined {
    return optRowFromJson<TaskRow>(this.store.getTask(id))
  }

  listTasks(filter?: TaskFilter): TaskRow[] {
    return listFromJson<TaskRow>(this.store.listTasks(statusFilter(filter), filter?.runId))
  }

  listTasksWithDispatch(filter?: TaskFilter): TaskWithDispatchRow[] {
    return listFromJson<TaskWithDispatchRow>(
      this.store.listTasksWithDispatch(statusFilter(filter), filter?.runId)
    )
  }

  updateTaskStatus(id: string, status: TaskStatus, result?: string): TaskRow | undefined {
    // The exact ISO completion stamp is minted here (not in SQL) so it is
    // byte-identical to what the deleted TS store wrote.
    const completedAt =
      status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    return optRowFromJson<TaskRow>(
      this.store.updateTaskStatus(id, status, result ?? null, completedAt)
    )
  }
}
