/** The stateful multi-agent orchestration store (messages/tasks/dispatch/gates/
 *  coordinator runs/runs/questions/federation/legacy compatibility) backed by
 *  orca-runtime's bundled SQLite, exposed by the same `orca_node.node` addon
 *  `rust-git-addon.ts` loads. Lives in its own module because the store surface
 *  alone is ~135 methods.
 *
 *  The main-process `OrchestrationDb` shim holds ONE of these and delegates
 *  every method to it; the deleted TS `node:sqlite` twin was byte-identical.
 *  Row-returning methods return the JSON string of the TS Row shape (parse on
 *  the shim side); the shim owns all JS-side nondeterminism (generated ids, ISO
 *  completion stamps, display strings) and passes it IN — every other timestamp
 *  is SQLite's `datetime('now')`. Methods throw on store errors (matching the TS
 *  twin's thrown Error text for the dispatch/task guard paths).
 *
 *  Argument convention, so this can be audited against db.ts line by line: a
 *  method whose db.ts counterpart takes a params **object** takes one
 *  `paramsJson` string holding exactly that object's camelCase keys; a method
 *  whose db.ts counterpart takes positional scalars keeps positional scalars. A
 *  positional `unknown[]` (effects) travels as a JSON-array string. The
 *  per-method key list — including the few places the shim must add a
 *  caller-minted id db.ts generates inline — is on the binding itself in
 *  `native/orca-node/src/orchestration_store.rs`.
 *
 *  Coded failures: `OrchestrationError` arrives as a JS `Error` whose `message`
 *  is a JSON envelope carrying `_orcaOrchestrationError: true`, `code`,
 *  `message` and `data`. The shim parses it and rethrows an `OrchestrationError`
 *  so callers can keep branching on `code`. */
export type RustOrchestrationStoreHandle = {
  // messages
  /** TS `insertMessage`: carries `runId`/`deliveryContract` and enforces `requireRun`. */
  insertRunMessage(paramsJson: string): string
  getMessageById(id: string): string | null
  /** Rewrite a superseded worker_done/heartbeat into an audit-only rejection. */
  convertLifecycleMessageToRejection(id: string, code: string, reason: string): string | null
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
  // runs
  /** `{ id, objective, coordinatorHandle, coordinatorPaneKey }` — `id` is the shim's `run_<hex>`. */
  createRun(paramsJson: string): string
  getRun(id: string): string | null
  /** `{ limit?, cursor? }` → `{ runs, nextCursor }`; the cursor is opaque, hand it back unmodified. */
  listRuns(paramsJson: string): string
  bindRun(paramsJson: string): string | null
  getCurrentRunForPane(paneKey: string): string | null
  /** `{ runId, consumerGeneration, deliveryId, limit?, wakeTypes? }` — `deliveryId` is the shim's `delivery_<hex>`. */
  getOrCreateRunDelivery(paramsJson: string): string | null
  acknowledgeRunDelivery(paramsJson: string): string
  hasPendingCurrentDelivery(runId: string): boolean
  getRunMailboxHistory(runId: string, limit: number, types: string[] | undefined): string
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
  listTasks(status: string | undefined, runId: string | undefined): string
  listTasksWithDispatch(status: string | undefined, runId: string | undefined): string
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
    launchTokenHash: string | null
  ): string
  getDispatchContext(taskId: string): string | null
  getDispatchContextById(id: string): string | null
  getActiveDispatchForTerminal(handle: string): string | null
  getActiveDispatchForIdentity(handle: string, paneKey: string | undefined): string | null
  getLatestDispatchForTerminal(handle: string): string | null
  /** The raw probe; the TS twin's per-instance memo (and its reset invalidation) stays shim-side. */
  hasAnyDispatchContexts(): boolean
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
  // dispatch capabilities — the store owns the CSPRNG and returns the plaintext
  // `dcap_` token exactly once; never generate or persist one caller-side.
  mintDispatchCapability(paramsJson: string): string
  verifyDispatchCapability(paramsJson: string): string
  revokeDispatchCapability(dispatchId: string): void
  commitDispatchLaunchTokenHash(dispatchId: string, launchTokenHash: string): string
  isDispatchProcessCurrent(paramsJson: string): boolean
  // questions
  /** `{ messageId, runId, dispatchId, askerHandle, question, options? }` — `messageId` is the shim's `msg_<hex>` and becomes the thread id. */
  createQuestion(paramsJson: string): string
  getQuestion(messageId: string): string | null
  /** `{ messageId, runId, consumerGeneration, answerMessageId, body }` — `answerMessageId` is the shim's `msg_<hex>` for the reply. */
  answerQuestion(paramsJson: string): string
  closeQuestionsForDispatch(dispatchId: string): string[]
  getRemoteQuestion(messageId: string): string | null
  answerRemoteQuestion(paramsJson: string): void
  registerFederatedQuestion(paramsJson: string): void
  findLegacyQuestionsBySemanticIdentity(paramsJson: string): string
  findPendingLegacyQuestions(paramsJson: string): string
  // worker dispatches
  /** `{ dispatchId, taskId, startOptions, … }` — `dispatchId` is the shim's `ctx_<hex>`; `startOptions` is already `JSON.stringify`d. */
  createStartingWorkerDispatch(paramsJson: string): string
  getWorkerDispatch(dispatchId: string): string | null
  markWorkerDispatchReady(dispatchId: string, effectsJson: string | undefined): string
  markWorkerStartUnknown(dispatchId: string, stage: string, reason: string): string
  /** Diverges from the TS twin: an unknown dispatch id raises coded `dispatch_not_found` instead of returning undefined. */
  markWorkerStopUnknown(dispatchId: string, reason: string): string
  failWorkerStart(dispatchId: string, stage: string, reason: string): string
  beginWorkerStop(dispatchId: string): string
  settleWorkerStop(dispatchId: string): string
  settleWorkerReport(paramsJson: string): string
  abandonWorkerDispatch(dispatchId: string): string
  recordWorkerStage(paramsJson: string): string
  updateWorkerSetupEvidence(paramsJson: string): string
  /** Returns the freshly minted plaintext `dcap_` token — hand it to the launcher once, never persist it. */
  prepareStartingWorkerAuthority(paramsJson: string): string
  reconcileMissingWorkerTerminal(dispatchId: string, reason: string): string
  listLegacyWorkerTerminalRecoveryRows(): string
  // federation
  getFederatedDispatch(dispatchId: string): string | null
  listActiveFederatedDispatches(runId: string | undefined): string
  updateFederatedDispatchResources(paramsJson: string): string
  reconcileFederatedWorkerStart(paramsJson: string): string
  reconcileFederatedWorkerStop(dispatchId: string): string
  resumeFederatedWorkerForTerminalRelay(dispatchId: string): string
  setFederatedHomeImportSequence(dispatchId: string, sequence: number): void
  /** Omit `messageId` and the STORE mints the `relay_<hex>` — do not pre-generate one. */
  enqueueFederationRelay(paramsJson: string): string
  listFederationRelay(paramsJson: string): string
  listPendingFederationRelay(dispatchId: string, direction: string, limit: number): string
  acknowledgeFederationRelay(paramsJson: string): void
  /** `message` uses the wire keys `{ id, runId, from, to, subject, body, type, priority, threadId?, payload? }`. */
  importFederatedRelayItem(paramsJson: string): string
  // remote dispatch attachments (the worker side of federation)
  createRemoteDispatchAttachment(paramsJson: string): string
  getRemoteDispatchAttachment(dispatchId: string): string | null
  findActiveRemoteAttachmentForPane(paneKey: string): string | null
  markRemoteAttachmentReady(dispatchId: string, effectsJson: string | undefined): string
  markRemoteAttachmentStopUnknown(dispatchId: string, reason: string): string
  beginRemoteAttachmentStop(dispatchId: string): string
  settleRemoteAttachmentStop(dispatchId: string): string
  failRemoteAttachment(dispatchId: string, stage: string, reason: string, unknown: boolean): string
  recordRemoteAttachmentStage(paramsJson: string): string
  updateRemoteAttachmentSetupEvidence(paramsJson: string): string
  /** Returns the freshly minted plaintext `dcap_` token. */
  prepareRemoteAttachmentAuthority(paramsJson: string): string
  verifyRemoteAttachmentAuthority(paramsJson: string): boolean
  isRemoteAttachmentProcessCurrent(paramsJson: string): boolean
  setRemoteWorkerImportSequence(dispatchId: string, sequence: number): void
  // mutation receipts
  beginMutationReceipt(paramsJson: string): string
  completeMutationReceipt(paramsJson: string): string
  discardPendingMutationReceipt(callerFingerprint: string, requestId: string): void
  getMutationReceipt(callerFingerprint: string, requestId: string): string | null
  // legacy compatibility
  getLegacyAdoption(): string | null
  /** `{ id, runId, … }` — `id` is the shim's `legacy_principal_<hex>`. */
  commitLegacyCompatibilityPrincipal(paramsJson: string): string
  getLegacyCompatibilityPrincipal(id: string): string | null
  listLegacyCompatibilityPrincipals(runId: string): string
  getLegacyCoordinatorPrincipal(runId: string): string | null
  setLegacyCompatibilityPrincipalStatus(id: string, status: string): string | null
  isLegacyCoordinatorHandle(runId: string, terminalHandle: string): boolean
  getLegacyOperationReceipt(principalId: string, operationKey: string): string | null
  resolveLegacyCompatibilityPrincipalByIdentity(paramsJson: string): string | null
  resolveLegacyCoordinatorCandidate(paramsJson: string): string | null
  /** Returns the bare DispatchContextRow JSON; db.ts returns `{ dispatch }`, so the shim wraps it. */
  resolveLegacyWorkerCandidate(paramsJson: string): string | null
  findLegacyWorkerCompletion(paramsJson: string): string | null
  getLegacyMailPage(paramsJson: string): string
  getLegacyMailHistory(paramsJson: string): string
  acknowledgeLegacyMail(paramsJson: string): string
  acknowledgeLegacyQuestionAnswer(paramsJson: string): string
  /** The store mints the `msg_<hex>` it writes; pass `message.existingId` only on a retry that already minted one. */
  commitLegacyLifecycleOperation(paramsJson: string): string
  commitLegacyAskOperation(paramsJson: string): string
  commitLegacyReplyOperation(paramsJson: string): string
  // decision gates
  createGate(
    id: string,
    taskId: string,
    question: string,
    options: string[],
    originMessageId: string | null
  ): string
  resolveGate(id: string, resolution: string): string | null
  timeoutGate(id: string): string | null
  listGates(taskId: string | undefined, status: string | undefined): string
  getGate(id: string): string | null
  // coordinator runs
  createCoordinatorRun(
    id: string,
    spec: string,
    coordinatorHandle: string,
    pollIntervalMs: number | undefined
  ): string
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
  /** Raw-SQL seam for fork specs and tooling only — never a production path.
   *  `paramsJson` is a JSON array of bind values; an empty array runs `sql` as a
   *  multi-statement batch. See orchestration-sqlite-probe.ts. */
  rawExec(sql: string, paramsJson: string): void
  /** Rows as a JSON array of column-keyed objects. Tests only. */
  rawQueryJson(sql: string, paramsJson: string): string
  close(): void
}

export type RustOrchestrationStoreCtor = new (path: string) => RustOrchestrationStoreHandle
