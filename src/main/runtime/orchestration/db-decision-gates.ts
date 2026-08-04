import { OrchestrationTaskStore } from './db-tasks'
import { generateId } from './orchestration-store-bridge'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import type { CoordinatorRun, CoordinatorStatus, DecisionGateRow, GateStatus } from './types'

export class OrchestrationGateStore extends OrchestrationTaskStore {
  createGate(gate: {
    taskId: string
    question: string
    options?: string[]
    // Why: stamps the `ask` message this gate came from so resolving it can answer
    // that exact blocked call instead of leaving the asker hung to timeout.
    originMessageId?: string
  }): DecisionGateRow {
    return rowFromJson<DecisionGateRow>(
      this.store.createGate(
        generateId('gate'),
        gate.taskId,
        gate.question,
        gate.options ?? [],
        gate.originMessageId ?? null
      )
    )
  }

  resolveGate(gateId: string, resolution: string): DecisionGateRow | undefined {
    return optRowFromJson<DecisionGateRow>(this.store.resolveGate(gateId, resolution))
  }

  timeoutGate(gateId: string): DecisionGateRow | undefined {
    return optRowFromJson<DecisionGateRow>(this.store.timeoutGate(gateId))
  }

  listGates(filter?: { taskId?: string; status?: GateStatus }): DecisionGateRow[] {
    return listFromJson<DecisionGateRow>(this.store.listGates(filter?.taskId, filter?.status))
  }

  getGate(id: string): DecisionGateRow | undefined {
    return optRowFromJson<DecisionGateRow>(this.store.getGate(id))
  }

  // ── Coordinator Runs ──

  createCoordinatorRun(run: {
    spec: string
    coordinatorHandle: string
    pollIntervalMs?: number
  }): CoordinatorRun {
    // The prefix really is `run`, matching the deleted TS store.
    return rowFromJson<CoordinatorRun>(
      this.store.createCoordinatorRun(
        generateId('run'),
        run.spec,
        run.coordinatorHandle,
        run.pollIntervalMs
      )
    )
  }

  getCoordinatorRun(id: string): CoordinatorRun | undefined {
    return optRowFromJson<CoordinatorRun>(this.store.getCoordinatorRun(id))
  }

  updateCoordinatorRun(id: string, status: CoordinatorStatus): CoordinatorRun | undefined {
    const completedAt =
      status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    return optRowFromJson<CoordinatorRun>(this.store.updateCoordinatorRun(id, status, completedAt))
  }

  getActiveCoordinatorRun(): CoordinatorRun | undefined {
    return optRowFromJson<CoordinatorRun>(this.store.getActiveCoordinatorRun())
  }

  // Why: orchestrators may run concurrently (#4389) — gating needs every running row.
  getActiveCoordinatorRuns(): CoordinatorRun[] {
    return listFromJson<CoordinatorRun>(this.store.getActiveCoordinatorRuns())
  }

  // ── Queries for Coordinator ──

  getIdleTerminals(excludeHandles: string[] = []): string[] {
    return listFromJson<string>(this.store.getIdleTerminals(excludeHandles))
  }
}
