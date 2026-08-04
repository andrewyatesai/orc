import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import type { CoordinatorRun, GateStatus, OrchestrationDb } from '../../orchestration/db'
import { Coordinator } from '../../orchestration/coordinator'
import { CoordinatorRunLogRegistry } from '../../orchestration/coordinator-run-log'
import { deliverGateResolutionToOrigin } from '../../orchestration/gate-reply-coupling'
import { resolveRunScope } from './orchestration-run-scope'
import { OrchestrationError } from '../../orchestration/orchestration-error'

// Why: live coordinators are keyed by run id so orchestration.runStop can
// target one without touching the others. Runs are keyed by coordinator
// handle (#4389): one live run per handle, but different handles may
// coordinate concurrently in the same workspace.
const activeCoordinators = new Map<string, { coordinator: Coordinator; handle: string }>()

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
  options: OptionalString,
  from: OptionalString,
  run: OptionalString
})

const GateResolveParams = z.object({
  id: requiredString('Missing --id'),
  resolution: requiredString('Missing --resolution'),
  from: OptionalString,
  run: OptionalString
})

const RunLogParams = z.object({
  runId: OptionalString,
  from: OptionalString
})

const GateListParams = z.object({
  task: OptionalString,
  status: z.enum(['pending', 'resolved', 'timeout']).optional(),
  from: OptionalString,
  run: OptionalString
})

export const ORCHESTRATION_GATE_METHODS: RpcMethod[] = [
  // Why: Section 4.12 — orchestration.run returns immediately with a run ID.
  // The coordinator loop runs in the background; progress is queried via
  // orchestration.taskList. This prevents the RPC call from blocking the
  // CLI (or any caller) for the entire duration of the pipeline.
  defineMethod({
    name: 'orchestration.run',
    params: RunParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()

      const coordinatorHandle = params.from ?? 'coordinator'
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

      // Why: fire-and-forget — the coordinator loop runs in the event loop
      // background. Results are persisted to the DB; callers query via
      // orchestration.taskList or orchestration.runStatus.
      coordinator.runFromExistingRun(run.id).finally(() => {
        if (activeCoordinators.get(run.id)?.coordinator === coordinator) {
          activeCoordinators.delete(run.id)
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
        // Why: an untargeted stop with several orchestrators live would pick one
        // arbitrarily — the mutual-kill in #4389 — so demand a target instead.
        if (activeRuns.length > 1) {
          throw new Error(
            `Multiple active coordinator runs (${activeRuns
              .map((candidate) => `${candidate.id}:${candidate.coordinator_handle}`)
              .join(', ')}); pass --run <run_id> or --from <handle>`
          )
        }
        run = activeRuns[0]
      }

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
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
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
      const task = db.getTask(params.task)
      if (!task) {
        throw new Error(`Task not found: ${params.task}`)
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      if (task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
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
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const existing = db.getGate(params.id)
      if (!existing) {
        throw new Error(`Gate not found: ${params.id}`)
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      // Why: a gate outside the caller's Run is indistinguishable from a missing one, so probing cannot map foreign Runs.
      if (existing.run_id !== run.id) {
        throw new Error(`Gate not found: ${params.id}`)
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
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      // Why: same read posture as taskList — an explicitly named Run is inspectable, an unnamed one means the caller's own.
      const run =
        explicitRun?.legacy === 1
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.from,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence
            })
      const gates = db
        .listGates({
          taskId: params.task,
          status: params.status as GateStatus
        })
        .filter((gate) => gate.run_id === run.id)
      return { runId: run.id, gates, count: gates.length }
    }
  })
]
