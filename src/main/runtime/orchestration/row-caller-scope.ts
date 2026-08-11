// Why: tasks, gates and coordinator runs are workspace-wide catalogs — the mail
// catalog's problem one table over. So they take the same answer orchestration.inbox
// already takes: filter the rows to the panes the caller reaches rather than refuse
// the call. A row no reachable pane answers for is hidden, never granted — an
// un-owned row must not become the way around the bound.
import {
  CallerScopeDeniedError,
  getCallerScope,
  isBoundedCallerScope
} from '../runtime-caller-scope'
import type { CoordinatorRun, DecisionGateRow, DispatchContextRow, TaskRow } from './types'

/** The runtime seam this needs: one boolean per terminal handle. */
type TerminalHandleReach = {
  isTerminalHandleReachableByCaller(handle: string): boolean
}

/** Structural on purpose, so a test double is a plain object literal. */
type OrchestrationRowSource = {
  getTask(id: string): TaskRow | undefined
  getDispatchContext(taskId: string): DispatchContextRow | undefined
  getCoordinatorRun(id: string): CoordinatorRun | undefined
}

/** A task row from either accessor — listTasksWithDispatch joins the assignee on. */
export type TaskRowMaybeJoined = TaskRow & { assignee_handle?: string | null }

export type OrchestrationRowReach = {
  run(run: Pick<CoordinatorRun, 'coordinator_handle'>): boolean
  task(task: TaskRowMaybeJoined): boolean
  gate(gate: Pick<DecisionGateRow, 'task_id' | 'run_id'>): boolean
  /** For a task named by a selector rather than read out of a listing. */
  assertTaskId(taskId: string): void
  assertTask(task: TaskRowMaybeJoined): void
  assertGate(gate: Pick<DecisionGateRow, 'task_id' | 'run_id'>): void
}

function refuse(subject: string): never {
  const scope = getCallerScope()
  throw new CallerScopeDeniedError(
    `Refused: ${subject} is owned by panes ${
      scope.kind === 'ssh' ? `outside SSH host ${scope.connectionId}` : 'this command cannot name'
    }. A remote pane may only reach the tasks, gates and runs its own panes created, ran or coordinate.`
  )
}

export function createOrchestrationRowReach(
  db: OrchestrationRowSource,
  runtime: TerminalHandleReach
): OrchestrationRowReach {
  // Why read once, up front: a local caller reaches everything, so no row costs
  // a handle lookup, a dispatch read or a run read on the unrestricted path.
  const bounded = isBoundedCallerScope(getCallerScope())
  const runReach = new Map<string, boolean>()
  const taskReach = new Map<string, boolean>()

  const reachesHandle = (handle: string | null | undefined): boolean =>
    typeof handle === 'string' &&
    handle.length > 0 &&
    runtime.isTerminalHandleReachableByCaller(handle)

  const reachesRunId = (runId: string | null | undefined): boolean => {
    if (!runId) {
      return false
    }
    const cached = runReach.get(runId)
    if (cached !== undefined) {
      return cached
    }
    const run = db.getCoordinatorRun(runId)
    const reached = run ? reachesHandle(run.coordinator_handle) : false
    runReach.set(runId, reached)
    return reached
  }

  const reachesTask = (task: TaskRowMaybeJoined): boolean => {
    const cached = taskReach.get(task.id)
    if (cached !== undefined) {
      return cached
    }
    // The three panes a task names: who asked for it, who is running it, whose
    // loop owns it. The dispatch read is the fallback for a plain task row and
    // for a settled dispatch the active-only join reports as null.
    const assignee = task.assignee_handle ?? db.getDispatchContext(task.id)?.assignee_handle
    const reached =
      reachesHandle(task.created_by_terminal_handle) ||
      reachesHandle(assignee) ||
      reachesRunId(task.run_id)
    taskReach.set(task.id, reached)
    return reached
  }

  const reachesTaskId = (taskId: string | null | undefined): boolean => {
    if (!taskId) {
      return false
    }
    const cached = taskReach.get(taskId)
    if (cached !== undefined) {
      return cached
    }
    const task = db.getTask(taskId)
    const reached = task ? reachesTask(task) : false
    taskReach.set(taskId, reached)
    return reached
  }

  const reachesGate = (gate: Pick<DecisionGateRow, 'task_id' | 'run_id'>): boolean =>
    reachesTaskId(gate.task_id) || reachesRunId(gate.run_id)

  return {
    run: (run) => !bounded || reachesHandle(run.coordinator_handle),
    task: (task) => !bounded || reachesTask(task),
    gate: (gate) => !bounded || reachesGate(gate),
    assertTaskId: (taskId) => {
      if (bounded && !reachesTaskId(taskId)) {
        refuse(`task ${taskId}`)
      }
    },
    assertTask: (task) => {
      if (bounded && !reachesTask(task)) {
        refuse(`task ${task.id}`)
      }
    },
    assertGate: (gate) => {
      if (bounded && !reachesGate(gate)) {
        refuse(`the gate on task ${gate.task_id}`)
      }
    }
  }
}
