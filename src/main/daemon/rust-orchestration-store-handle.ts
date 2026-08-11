// The stateful multi-agent orchestration store surface (schema-versioned:
// messages/tasks/dispatch/gates/coordinator runs, v10 capabilities, v11
// mutation receipts) backed by orca-runtime's bundled SQLite. Extracted from
// rust-git-addon.ts so that surface can keep growing per schema rung without
// bloating the binding-loader module.

/** The stateful multi-agent orchestration store (messages/tasks/dispatch/gates/
 *  coordinator runs) backed by orca-runtime's bundled SQLite. The main-process
 *  `OrchestrationDb` shim holds ONE of these and delegates every method to it;
 *  the deleted TS `node:sqlite` twin was byte-identical. Row-returning methods
 *  return the JSON string of the TS Row shape (parse on the shim side); the
 *  shim owns all JS-side nondeterminism (generated ids, ISO completion stamps,
 *  display strings) and passes it IN — every other timestamp is SQLite's
 *  `datetime('now')`. Methods throw on store errors (matching the TS twin's
 *  thrown Error text for the dispatch/task guard paths). */
export type RustOrchestrationStoreHandle = {
  // messages
  insertMessage(
    id: string,
    fromHandle: string,
    toHandle: string,
    subject: string,
    body: string,
    messageType: string,
    priority: string,
    threadId: string | null,
    payload: string | null,
    senderPaneKey: string | null,
    recipientPaneKey: string | null
  ): string
  getMessageById(id: string): string | null
  /** Rewrite a superseded worker_done/heartbeat into an audit-only rejection.
   *  `code` selects the persisted marker code; omitted = `sender_not_assignee`. */
  convertLifecycleMessageToRejection(id: string, reason: string, code?: string | null): string | null
  getUnreadMessages(handle: string, types: string[] | undefined): string
  getUndeliveredUnreadMessages(handle: string, types: string[] | undefined): string
  getAllMessages(handle: string, limit: number): string
  getAllMessagesForHandle(handle: string, limit: number, types: string[] | undefined): string
  getInbox(limit: number): string
  getThreadMessagesFor(
    threadId: string,
    toHandle: string,
    afterSequence: number | undefined
  ): string
  markAsRead(ids: string[]): void
  markAsDelivered(ids: string[]): void
  markAsReadAndDelivered(ids: string[]): void
  // tasks
  createTask(
    id: string,
    spec: string,
    parentId: string | null,
    deps: string[],
    createdBy: string | null,
    taskTitle: string | null,
    displayName: string | null,
    runId: string | null
  ): string
  getTask(id: string): string | null
  /** `runId` undefined is "no run filter" — un-owned legacy rows still list. */
  listTasks(status: string | undefined, runId: string | undefined): string
  listTasksWithDispatch(status: string | undefined): string
  updateTaskStatus(
    id: string,
    status: string,
    result: string | null,
    completedAt: string | null
  ): string | null
  // dispatch contexts
  createDispatchContext(
    taskId: string,
    assigneeHandle: string,
    id: string,
    assigneePaneKey: string | null,
    /** The dispatching run claims the task when it has no owner yet (v9). */
    runId: string | null
  ): string
  getDispatchContext(taskId: string): string | null
  getDispatchContextById(id: string): string | null
  getActiveDispatchForTerminal(handle: string): string | null
  getLatestDispatchForTerminal(handle: string): string | null
  completeDispatch(id: string): void
  completeActiveDispatchForTask(taskId: string): void
  failActiveDispatchForTask(taskId: string, error: string): string | null
  failDispatch(id: string, error: string): string | null
  recordHeartbeat(id: string, at: string): void
  getStaleDispatches(thresholdIso: string): string
  setDispatchTimestamps(
    id: string,
    dispatchedAt: string | null,
    lastHeartbeatAt: string | null
  ): void
  // dispatch capabilities (v10). Coded failures (dispatch_inactive,
  // dispatch_not_found, request_mismatch) cross as a JSON envelope in
  // Error.message — restore with orchestration-error.ts.
  /** Mints the dcap_ secret store-side; returns the plaintext ONCE (only its
   *  SHA-256 is persisted). */
  mintDispatchCapability(
    dispatchId: string,
    paneKey: string,
    processIncarnation: string
  ): string
  /** Verdict JSON: `{"valid":true}` | `{"valid":false,"reason":…}`. */
  verifyDispatchCapability(
    dispatchId: string,
    capability: string | null,
    paneKey: string | null,
    processIncarnation: string | null
  ): string
  revokeDispatchCapability(dispatchId: string): void
  /** First commitment wins; returns the updated dispatch row JSON. */
  commitDispatchLaunchTokenHash(dispatchId: string, launchTokenHash: string): string
  isDispatchProcessCurrent(
    dispatchId: string,
    paneKey: string | null,
    processIncarnation: string | null
  ): boolean
  // mutation receipts (v11) — the durable RPC idempotency ledger. Coded
  // failures (request_mismatch, mutation_ledger_full) cross as a JSON envelope
  // in Error.message — restore with orchestration-error.ts.
  /** Claims the (caller, request) slot. Returns claim JSON
   *  `{"disposition":"started"|"pending"|"completed","row":{…}}`. */
  beginMutationReceipt(
    callerFingerprint: string,
    requestId: string,
    method: string,
    payloadHash: string
  ): string
  /** Stores the serialized result for replay; returns the completed row JSON. */
  completeMutationReceipt(
    callerFingerprint: string,
    requestId: string,
    method: string,
    payloadHash: string,
    receipt: string
  ): string
  /** Releases a pending slot whose mutation threw; a completed receipt is kept. */
  discardPendingMutationReceipt(callerFingerprint: string, requestId: string): void
  getMutationReceipt(callerFingerprint: string, requestId: string): string | null
  // decision gates
  createGate(
    id: string,
    taskId: string,
    question: string,
    options: string[],
    originMessageId: string | null,
    runId: string | null,
    category: string | null,
    defaultOption: string | null,
    managerDeadlineAt: string | null,
    hardDeadlineAt: string | null,
    policySnapshot: string | null
  ): string
  resolveGate(id: string, resolution: string): string | null
  /** CAS resolve (v9). Returns a tagged-outcome JSON — a lost race is a result,
   *  not a throw, so the loser can read the winner's committed row. */
  resolvePendingGate(
    id: string,
    expectedVersion: number,
    resolution: string,
    resolvedBy: string,
    resolutionReason: string | null,
    resolvedAt: string
  ): string
  /** Park the task's active dispatch on its gate instead of completing it. */
  parkDispatchWaitingGate(taskId: string): string | null
  listDispatchesWaitingGate(): string
  getPendingGateForTask(taskId: string): string | null
  timeoutGate(id: string): string | null
  listGates(
    taskId: string | undefined,
    status: string | undefined,
    runId: string | undefined
  ): string
  getGate(id: string): string | null
  // coordinator runs
  /** Opens the run and adopts every un-owned live task into it, atomically (v9). */
  createCoordinatorRun(
    id: string,
    spec: string,
    coordinatorHandle: string,
    pollIntervalMs: number | undefined,
    gateResolutionPolicy: string | null,
    gateCategoryAllowlist: string | null
  ): string
  /** Bounded run history, newest first — a real LIMIT/OFFSET query (v9). */
  listCoordinatorRuns(limit: number, offset: number): string
  /** Append-only audit ledger (v9); the schema trigger refuses UPDATE. */
  appendAuditEvent(
    id: string,
    runId: string | null,
    actor: string,
    action: string,
    targetPaneKey: string | null,
    targetHandle: string | null,
    evidenceRef: string | null,
    detail: string | null
  ): string
  listAuditEvents(runId: string | undefined, limit: number, offset: number): string
  /** Sweep expired reservations and claim the target in one transaction (v9). */
  claimRotationReservation(
    id: string,
    provider: string,
    targetRouteKey: string,
    targetStoreKey: string | null,
    sourceRouteKey: string | null,
    expiresAt: string,
    now: string
  ): string
  releaseRotationReservation(id: string, fence: number, now: string): boolean
  renewRotationReservation(id: string, fence: number, expiresAt: string, now: string): boolean
  advanceRotationSagaPhase(
    id: string,
    fence: number,
    phase: string,
    lastError: string | null,
    now: string
  ): string | null
  getRotationSaga(id: string): string | null
  listLiveRotationSagas(provider: string | undefined): string
  getCoordinatorRun(id: string): string | null
  updateCoordinatorRun(id: string, status: string, completedAt: string | null): string | null
  getActiveCoordinatorRun(): string | null
  /** Every still-running coordinator, newest first — multi-orchestrator gating (#4389). */
  getActiveCoordinatorRuns(): string
  // queries + lifecycle
  getIdleTerminals(excludeHandles: string[]): string
  resetAll(): void
  resetTasks(): void
  resetMessages(): void
  /** Raw all-tables dump (real ids/timestamps) for the parity state harness. */
  dumpTablesJson(): string
  close(): void
}

export type RustOrchestrationStoreCtor = new (path: string) => RustOrchestrationStoreHandle
