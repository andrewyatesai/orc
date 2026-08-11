import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import type { CoordinatorRun, GateStatus, OrchestrationDb } from '../../orchestration/db'
import { Coordinator } from '../../orchestration/coordinator'
import { CoordinatorRunLogRegistry } from '../../orchestration/coordinator-run-log'
import { deliverGateResolutionToOrigin } from '../../orchestration/gate-reply-coupling'
import { countRunTasks } from '../../orchestration/run-progress'
import { createOrchestrationRowReach } from '../../orchestration/row-caller-scope'
import {
  assertLocalCallerScope,
  CallerScopeDeniedError,
  getCallerScope
} from '../../runtime-caller-scope'

// Why: live coordinators are keyed by run id so orchestration.runStop can
// target one without touching the others. Runs are keyed by coordinator
// handle (#4389): one live run per handle, but different handles may
// coordinate concurrently in the same workspace.
const activeCoordinators = new Map<string, { coordinator: Coordinator; handle: string }>()

/** A durable row still says `running` after a restart killed its loop, so this
 *  registry is the only witness that a run actually has a coordinator behind it. */
export function isCoordinatorRunLive(runId: string): boolean {
  return activeCoordinators.has(runId)
}

/** The worktree a live run is operating in — the only thing that can turn a
 *  task's claimed files into a real git comparison (§8.4). Undefined for a run
 *  with no loop behind it, which correctly degrades the check to `unknown`. */
export function getCoordinatorRunWorktreeId(runId: string): string | undefined {
  return activeCoordinatorWorktrees.get(runId)
}

const activeCoordinatorWorktrees = new Map<string, string>()

// Why: Coordinator.onLog defaulted to a no-op here, discarding the stale-heartbeat
// warning that is the codebase's only hang detector. Kept per run and reaped with it.
const coordinatorRunLogs = new CoordinatorRunLogRegistry()

function findLiveRunIdForHandle(handle: string): string | undefined {
  for (const [runId, entry] of activeCoordinators) {
    if (entry.handle === handle) {
      return runId
    }
  }
  return undefined
}

function markStaleCoordinatorRunFailed(db: OrchestrationDb, run: CoordinatorRun): void {
  // Why: a process restart loses the in-memory coordinator handle but can
  // leave the durable row marked running. Without a live handle, the row cannot
  // make progress, so fail it before accepting or acknowledging new lifecycle
  // commands.
  db.updateCoordinatorRun(run.id, 'failed')
}

const RunParams = z.object({
  spec: requiredString('Missing --spec'),
  from: OptionalString,
  pollIntervalMs: OptionalFiniteNumber,
  maxConcurrent: OptionalFiniteNumber,
  worktree: OptionalString
})

const RunStopParams = z.object({
  runId: OptionalString,
  from: OptionalString
})

const GateCreateParams = z.object({
  task: requiredString('Missing --task'),
  question: requiredString('Missing --question'),
  options: OptionalString
})

const GateResolveParams = z.object({
  id: requiredString('Missing --id'),
  resolution: requiredString('Missing --resolution')
})

const RunLogParams = z.object({
  runId: OptionalString,
  from: OptionalString
})

const GateListParams = z.object({
  task: OptionalString,
  status: z.enum(['pending', 'resolved', 'timeout']).optional(),
  runId: OptionalString
})

const RunListParams = z.object({
  limit: OptionalFiniteNumber,
  offset: OptionalFiniteNumber
})

// Why bounded: run history grows for the life of an install and every page costs
// a per-run task read, so an unbounded page would scan the whole workspace.
const DEFAULT_RUN_LIST_LIMIT = 20
const MAX_RUN_LIST_LIMIT = 100

function clampRunListLimit(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_RUN_LIST_LIMIT
  }
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_RUN_LIST_LIMIT)
}

function clampRunListOffset(requested: number | undefined): number {
  return requested === undefined ? 0 : Math.max(Math.trunc(requested), 0)
}

export const ORCHESTRATION_GATE_METHODS: RpcMethod[] = [
  // Why: Section 4.12 — orchestration.run returns immediately with a run ID.
  // The coordinator loop runs in the background; progress is queried via
  // orchestration.taskList. This prevents the RPC call from blocking the
  // CLI (or any caller) for the entire duration of the pipeline.
  defineMethod({
    name: 'orchestration.run',
    params: RunParams,
    handler: async (params, { runtime }) => {
      // Why: the coordinator loop creates terminals and dispatches work into
      // them, so the workspace it runs in is the object — and a run that names
      // no workspace lands on the machine running Orca.
      await runtime.assertWorkspaceSelectorInCallerScope(params.worktree, 'a coordinator run')
      const db = runtime.getOrchestrationDb()

      const coordinatorHandle = params.from ?? 'coordinator'
      runtime.assertTerminalHandleInCallerScope(coordinatorHandle, 'coordinator')
      const liveRunId = findLiveRunIdForHandle(coordinatorHandle)
      if (liveRunId) {
        throw new Error(`Coordinator already running: ${liveRunId}`)
      }
      // Why: only rows owned by THIS handle gate or get reaped here — another
      // handle's live run must neither block this start nor be failed as stale.
      for (const existing of db.getActiveCoordinatorRuns()) {
        if (existing.coordinator_handle !== coordinatorHandle) {
          continue
        }
        if (activeCoordinators.has(existing.id)) {
          throw new Error(`Coordinator already running: ${existing.id}`)
        }
        markStaleCoordinatorRunFailed(db, existing)
      }

      const run = db.createCoordinatorRun({
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs
      })

      const runLog = coordinatorRunLogs.forRun(run.id)
      const coordinator = new Coordinator(db, runtime, {
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs,
        maxConcurrent: params.maxConcurrent,
        worktree: params.worktree,
        onLog: (message) => runLog.append(message, Date.now())
      })

      activeCoordinators.set(run.id, { coordinator, handle: coordinatorHandle })
      if (params.worktree) {
        activeCoordinatorWorktrees.set(run.id, params.worktree)
      }

      // Why: fire-and-forget — the coordinator loop runs in the event loop
      // background. Results are persisted to the DB; callers query via
      // orchestration.taskList or orchestration.runStatus.
      coordinator.runFromExistingRun(run.id).finally(() => {
        if (activeCoordinators.get(run.id)?.coordinator === coordinator) {
          activeCoordinators.delete(run.id)
          activeCoordinatorWorktrees.delete(run.id)
        }
      })

      return { runId: run.id, status: 'running' }
    }
  }),

  defineMethod({
    name: 'orchestration.runStop',
    params: RunStopParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const activeRuns = db.getActiveCoordinatorRuns()

      let run: CoordinatorRun
      if (params.runId) {
        const match = activeRuns.find((candidate) => candidate.id === params.runId)
        if (!match) {
          throw new Error(`No active coordinator run: ${params.runId}`)
        }
        run = match
      } else if (params.from) {
        const match = activeRuns.find((candidate) => candidate.coordinator_handle === params.from)
        if (!match) {
          throw new Error(`No active coordinator run for handle: ${params.from}`)
        }
        run = match
      } else {
        if (activeRuns.length === 0) {
          throw new Error('No active coordinator run')
        }
        // Why filtered only on this branch: an untargeted stop names nothing, so
        // both the run it picks and the disambiguation it prints have to come from
        // the coordinators this caller reaches, never from every run in the
        // workspace — the id:handle list below is otherwise a roster of other hosts.
        const reachable = activeRuns.filter((candidate) =>
          runtime.isTerminalHandleReachableByCaller(candidate.coordinator_handle)
        )
        if (reachable.length === 0) {
          // Same shape as an unnamed terminal falling through: refuse by boundary,
          // and name nothing, because the caller named nothing to be told about.
          throw new CallerScopeDeniedError(
            'Refused: no coordinator run was named, and no run on this caller host is active to fall back to. Name your own run with --run <run_id> or --from <handle>.'
          )
        }
        // Why: an untargeted stop with several orchestrators live would pick one
        // arbitrarily — the mutual-kill in #4389 — so demand a target instead.
        if (reachable.length > 1) {
          throw new Error(
            `Multiple active coordinator runs (${reachable
              .map((candidate) => `${candidate.id}:${candidate.coordinator_handle}`)
              .join(', ')}); pass --run <run_id> or --from <handle>`
          )
        }
        run = reachable[0]
      }
      // Why after resolution: --run and the untargeted single-run case name no
      // handle, so the run row is the only thing that says whose loop this is.
      runtime.assertTerminalHandleInCallerScope(run.coordinator_handle, 'coordinator')

      const live = activeCoordinators.get(run.id)
      if (live) {
        live.coordinator.stop()
      } else {
        markStaleCoordinatorRunFailed(db, run)
      }

      return { runId: run.id, stopped: true }
    }
  }),

  defineMethod({
    name: 'orchestration.gateCreate',
    params: GateCreateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: a gate blocks its task and parks whoever is dispatched on it, so the
      // task is the object — the same one gateList filters the catalog by.
      createOrchestrationRowReach(db, runtime).assertTaskId(params.task)
      let options: string[] | undefined
      if (params.options) {
        try {
          const parsed = JSON.parse(params.options)
          if (!Array.isArray(parsed) || !parsed.every((option) => typeof option === 'string')) {
            throw new Error('not an array of strings')
          }
          options = parsed
        } catch {
          throw new Error('Invalid --options: must be a JSON array of strings')
        }
      }
      const gate = db.createGate({
        taskId: params.task,
        question: params.question,
        options
      })
      return { gate }
    }
  }),

  defineMethod({
    name: 'orchestration.gateResolve',
    params: GateResolveParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const pending = db.getGate(params.id)
      const originMessageId = pending?.origin_message_id
      const origin = originMessageId ? db.getMessageById(originMessageId) : undefined
      if (origin) {
        // Why before resolving: the resolution is delivered into the pane that
        // asked, so that pane is the object — and a gate must not be half-resolved
        // by a caller that may not reach it.
        runtime.assertTerminalHandleInCallerScope(origin.from_handle, 'gate asker')
      } else if (pending) {
        // Why the second bound: a gate from gateCreate — and every gate written
        // before schema v8 — names no asker, so the task it unblocks is the only
        // object it has.
        createOrchestrationRowReach(db, runtime).assertGate(pending)
      }
      const gate = db.resolveGate(params.id, params.resolution)
      if (!gate) {
        throw new Error(`Gate not found: ${params.id}`)
      }
      // Why: resolveGate alone unblocks the task but leaves the asking worker parked on
      // its thread until timeout — the board clears while the fleet is still stuck.
      const answered = deliverGateResolutionToOrigin(db, runtime, gate, params.resolution)
      return { gate, answeredOrigin: answered.delivered }
    }
  }),

  // Why: without this the coordinator's diagnostics have no reader at all — a mission
  // that stalls on a failed terminal creation looks identical to one that is just slow.
  defineMethod({
    name: 'orchestration.runLog',
    params: RunLogParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const runId = params.runId ?? findLiveRunIdForHandle(params.from ?? 'coordinator')
      if (!runId) {
        throw new Error('No active coordinator run; pass --run <run_id> or --from <handle>')
      }
      const logged = db.getCoordinatorRun(runId)
      if (logged) {
        runtime.assertTerminalHandleInCallerScope(logged.coordinator_handle, 'coordinator')
      } else {
        // Why: with no run row there is no coordinator handle to bound the
        // in-memory tail to, and that tail is this process's own diagnostics.
        assertLocalCallerScope(getCallerScope(), `the log for run ${runId}`)
      }
      const log = coordinatorRunLogs.peek(runId)
      if (!log) {
        // A finished or pre-restart run has no in-memory tail; say so rather than imply silence.
        return { runId, entries: [], dropped: 0, retained: false, run: db.getCoordinatorRun(runId) }
      }
      return {
        runId,
        entries: log.list(),
        dropped: log.dropped,
        retained: true,
        run: db.getCoordinatorRun(runId)
      }
    }
  }),

  defineMethod({
    name: 'orchestration.gateList',
    params: GateListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const reach = createOrchestrationRowReach(db, runtime)
      // Why filtered, not refused: this is the workspace gate catalog — every
      // question and its options — so a bounded caller sees the gates on the
      // tasks its panes own and never learns the rest exist.
      const gates = db
        .listGates({
          taskId: params.task,
          status: params.status as GateStatus,
          // An omitted runId is "no run filter", so gates from before v9 still list.
          runId: params.runId
        })
        .filter((gate) => reach.gate(gate))
      return { gates, count: gates.length }
    }
  }),

  // Why: run history is the supervisor's wake brief — after a restart it is the
  // only way to tell what the workspace was doing. It reads the paginated
  // coordinator_runs accessor, NOT the debug table dump the first attempt used.
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const limit = clampRunListLimit(params.limit)
      const offset = clampRunListOffset(params.offset)
      // One extra row answers "is there another page?" without a COUNT(*) scan.
      const page = db.runs.list({ limit: limit + 1, offset })
      const reach = createOrchestrationRowReach(db, runtime)
      // Why filtered after the page and not inside it: `hasMore` answers "is there
      // another row at this offset", which is a property of the history, not of
      // what this caller may see. A run is the coordinator pane's own object.
      const runs = page
        .slice(0, limit)
        .filter((run) => reach.run(run))
        .map((run) => ({
          ...run,
          // Why: a durable row still says `running` after a restart killed its
          // loop, so status alone cannot separate a live coordinator from a
          // stranded one. The in-memory registry is the only witness to that.
          live: activeCoordinators.has(run.id),
          // Why per run: these counters were once workspace-wide and identical on
          // every row, so a run that ended last week reported today's numbers.
          tasks: countRunTasks(db.listTasks({ runId: run.id })),
          // Why gates too: `blocked` says the work stopped; this says a human is
          // what it stopped on, which is the only one the supervisor can act on.
          pendingGates: db.listGates({ runId: run.id, status: 'pending' }).length
        }))
      return { runs, count: runs.length, limit, offset, hasMore: page.length > limit }
    }
  })
]
