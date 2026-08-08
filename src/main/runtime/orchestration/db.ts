import type {
  MessageType,
  MessagePriority,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  GateResolutionPolicy,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  AuditEventRow,
  RotationSagaRow,
  GateResolutionOutcome,
  ReservationClaimOutcome
} from './types'
import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import { OrchestrationMessageStore } from './message-store'
import { generateId } from './row-id'
import { AuditLedgerStore } from './audit-ledger'
import { DispatchCapabilityStore } from './dispatch-capabilities'
import { GatePolicyStore } from './gate-resolution'
import { RotationReservationStore } from './rotation-reservations'
import { RunOwnershipStore } from './run-ownership'

export type {
  MessageType,
  MessagePriority,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  GateResolutionPolicy,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  AuditEventRow,
  RotationSagaRow,
  GateResolutionOutcome,
  ReservationClaimOutcome
}

// The join shape returned by listTasksWithDispatch: a task row plus the active
// dispatch's assignee/id (or null when the task has no live dispatch).
type TaskWithDispatchRow = TaskRow & { assignee_handle: string | null; dispatch_id: string | null }

// Why: this class is a thin delegating shim over the orca-runtime SQLite store
// (the `OrchestrationStore` napi class). The `node:sqlite` twin — schema,
// migrations, every query — was deleted; Rust is the sole implementation. The
// shim keeps only the JS-side nondeterminism the Rust store must NOT own so the
// bytes stay identical to the deleted TS store: generated ids, the
// `new Date().toISOString()` completion/CAS/reservation stamps, the UTF-16-aware
// display derivation, and the RFC3339 exposure of message timestamps (see
// db-message-timestamp.ts). Everything else marshals through JSON
// (the store serializes each row to its TS Row shape). Row-returning getters map
// the store's `null` (absent row) back to `undefined` to preserve the old
// return contract.
//
// Messages live in the base class; schema v9's four concerns (run ownership,
// gate policy, the audit ledger, rotation reservations) hang off the properties
// below rather than flattening into this class.
export class OrchestrationDb extends OrchestrationMessageStore {
  /** Bounded run history — see run-ownership.ts for the adoption story. */
  readonly runs: RunOwnershipStore
  /** CAS gate resolution + `waiting_gate` dispatch parking (design §6.2). */
  readonly gatePolicy: GatePolicyStore
  /** Append-only ledger (design §7). */
  readonly audit: AuditLedgerStore
  /** Rotation-saga reservations (design §8.3). */
  readonly rotations: RotationReservationStore
  /** Dispatch capability tokens (schema v10) — mint/verify/revoke the dcap_ secret. */
  readonly capabilities: DispatchCapabilityStore

  // Why: buildAgentOrchestrationByPaneKey rebuilds context on every 16ms graph
  // publish, issuing ~2 napi dispatch lookups per terminal. The overwhelming
  // majority never orchestrate, so cache "any dispatch rows exist?" to let the
  // builder short-circuit the whole fan-out (#9694). createDispatchContext flips
  // it true; resets clear it back to a cold re-derive.
  private hasAnyDispatchContextsCache: boolean | undefined

  constructor(dbPath: string | ':memory:') {
    super(dbPath)
    this.runs = new RunOwnershipStore(this.store)
    this.gatePolicy = new GatePolicyStore(this.store)
    this.audit = new AuditLedgerStore(this.store)
    this.rotations = new RotationReservationStore(this.store)
    this.capabilities = new DispatchCapabilityStore(this.store)
  }

  // ── Tasks ──

  createTask(task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
    /** Owns the task at birth. Omitted before a run exists — that is the case
     *  `createCoordinatorRun`'s adoption transaction resolves. */
    runId?: string
  }): TaskRow {
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
        task.runId ?? null
      )
    )
  }

  getTask(id: string): TaskRow | undefined {
    return optRowFromJson<TaskRow>(this.store.getTask(id))
  }

  // An omitted runId is "no run filter", so un-owned legacy tasks still list;
  // it never means "un-owned only".
  listTasks(filter?: { status?: TaskStatus; ready?: boolean; runId?: string }): TaskRow[] {
    const status = filter?.ready ? 'ready' : filter?.status
    return listFromJson<TaskRow>(this.store.listTasks(status, filter?.runId))
  }

  listTasksWithDispatch(filter?: { status?: TaskStatus; ready?: boolean }): TaskWithDispatchRow[] {
    const status = filter?.ready ? 'ready' : filter?.status
    return listFromJson<TaskWithDispatchRow>(this.store.listTasksWithDispatch(status))
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

  // ── Dispatch Contexts ──

  createDispatchContext(
    taskId: string,
    assigneeHandle: string,
    // Why: the pane key is the remint-stable identity behind the handle;
    // recording it at dispatch time lets the store lock out a reminted handle
    // reopening a second concurrent dispatch on the same pane (v6 col).
    assigneePaneKey?: string,
    /** The dispatching run claims an un-owned task, so work created mid-run is
     *  still counted; an already-owned task keeps the run that adopted it. */
    runId?: string
  ): DispatchContextRow {
    // The store throws the same guard-path messages the TS twin did
    // (`Task not found: …`, `… is <status>; only ready …`, `Terminal … already
    // has an active dispatch (… for task …)`) — consumers match on `.message`.
    const row = rowFromJson<DispatchContextRow>(
      this.store.createDispatchContext(
        taskId,
        assigneeHandle,
        generateId('ctx'),
        assigneePaneKey ?? null,
        runId ?? null
      )
    )
    this.hasAnyDispatchContextsCache = true
    return row
  }

  /**
   * Cheap "could any terminal have an active or recent-completed dispatch?"
   * probe. When false, orchestration-context builders skip their per-terminal
   * query fan-out entirely (#9694). Cached after first probe.
   *
   * Why the task-emptiness derivation: the Rust store exposes no direct
   * dispatch_contexts existence probe, and listTasksWithDispatch surfaces only
   * the ACTIVE dispatch id (null for a persisted *completed* dispatch), so it
   * would wrongly report empty on a cold DB whose only dispatch has finished —
   * dropping recent-completed context. A dispatch always references a task, so
   * "no tasks at all" safely implies "no dispatches" (the never-orchestrate
   * majority). The rare tasks-without-dispatch cold case just skips the win.
   */
  hasAnyDispatchContexts(): boolean {
    return (this.hasAnyDispatchContextsCache ??= this.listTasks().length > 0)
  }

  getDispatchContext(taskId: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getDispatchContext(taskId))
  }

  getDispatchContextById(dispatchId: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getDispatchContextById(dispatchId))
  }

  getActiveDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getActiveDispatchForTerminal(handle))
  }

  getLatestDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getLatestDispatchForTerminal(handle))
  }

  completeDispatch(ctxId: string): void {
    this.store.completeDispatch(ctxId)
  }

  completeActiveDispatchForTask(taskId: string): void {
    this.store.completeActiveDispatchForTask(taskId)
  }

  failActiveDispatchForTask(taskId: string, error: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.failActiveDispatchForTask(taskId, error))
  }

  recordHeartbeat(dispatchId: string, at: string): void {
    this.store.recordHeartbeat(dispatchId, at)
  }

  getStaleDispatches(thresholdIso: string): DispatchContextRow[] {
    // Why: delegates to the Rust orca-runtime store, whose get_stale_dispatches
    // already carries the full #8452/#8514 fix (status='dispatched' + dispatched_at
    // grace + datetime()-wrapped comparison so space-format columns and ISO-Z
    // thresholds compare correctly). Upstream's TS julianday() reimplementation is
    // superseded by that Rust query.
    return listFromJson<DispatchContextRow>(this.store.getStaleDispatches(thresholdIso))
  }

  failDispatch(ctxId: string, error: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.failDispatch(ctxId, error))
  }

  // Backdate a dispatch's `dispatched_at` / `last_heartbeat_at` — the seam the
  // stale-dispatch tests use to reach into the grace window without sleeping.
  setDispatchTimestamps(
    dispatchId: string,
    dispatchedAt?: string | null,
    lastHeartbeatAt?: string | null
  ): void {
    this.store.setDispatchTimestamps(dispatchId, dispatchedAt ?? null, lastHeartbeatAt ?? null)
  }

  // ── Decision Gates ──

  createGate(gate: {
    taskId: string
    question: string
    options?: string[]
    originMessageId?: string
    /** v9 policy columns. All optional: a gate opened by today's `ask` path
     *  carries none of them and stays human-only by §6.3's fail-closed rule. */
    runId?: string
    category?: string
    defaultOption?: string
    managerDeadlineAt?: string
    hardDeadlineAt?: string
    policySnapshot?: string
  }): DecisionGateRow {
    return rowFromJson<DecisionGateRow>(
      this.store.createGate(
        generateId('gate'),
        gate.taskId,
        gate.question,
        gate.options ?? [],
        gate.originMessageId ?? null,
        gate.runId ?? null,
        gate.category ?? null,
        gate.defaultOption ?? null,
        gate.managerDeadlineAt ?? null,
        gate.hardDeadlineAt ?? null,
        gate.policySnapshot ?? null
      )
    )
  }

  // Legacy last-writer-wins resolution. The CAS path is db.gatePolicy.resolvePending.
  resolveGate(gateId: string, resolution: string): DecisionGateRow | undefined {
    return optRowFromJson<DecisionGateRow>(this.store.resolveGate(gateId, resolution))
  }

  timeoutGate(gateId: string): DecisionGateRow | undefined {
    return optRowFromJson<DecisionGateRow>(this.store.timeoutGate(gateId))
  }

  listGates(filter?: { taskId?: string; status?: GateStatus; runId?: string }): DecisionGateRow[] {
    return listFromJson<DecisionGateRow>(
      this.store.listGates(filter?.taskId, filter?.status, filter?.runId)
    )
  }

  getGate(id: string): DecisionGateRow | undefined {
    return optRowFromJson<DecisionGateRow>(this.store.getGate(id))
  }

  // ── Coordinator Runs ──

  /** Opens the run AND adopts every un-owned live task into it, atomically —
   *  see run-ownership.ts for why adoption is the option that shipped. */
  createCoordinatorRun(run: {
    spec: string
    coordinatorHandle: string
    pollIntervalMs?: number
    /** Defaults to `human-only` in SQL, so an omitted policy is fail-closed. */
    gateResolutionPolicy?: GateResolutionPolicy
    /** Delegable gate categories; only meaningful under `manager-delegated`. */
    gateCategoryAllowlist?: string[]
  }): CoordinatorRun {
    return rowFromJson<CoordinatorRun>(
      this.store.createCoordinatorRun(
        generateId('run'),
        run.spec,
        run.coordinatorHandle,
        run.pollIntervalMs,
        run.gateResolutionPolicy ?? null,
        run.gateCategoryAllowlist ? JSON.stringify(run.gateCategoryAllowlist) : null
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

  // ── Lifecycle ──

  resetAll(): void {
    this.store.resetAll()
    this.hasAnyDispatchContextsCache = undefined
  }

  resetTasks(): void {
    this.store.resetTasks()
    this.hasAnyDispatchContextsCache = undefined
  }
}
