//! Every orchestration table's row struct, its SELECT column list, and its
//! `rusqlite` reader — the shared vocabulary the domain modules import instead of
//! redeclaring.
//!
//! Field names and declaration order mirror `src/main/runtime/orchestration/
//! types.ts` exactly, because `Serialize` output is what the napi shim hands to
//! the TS callers. A column list and its reader are declared side by side so
//! they stay in lock-step order; a reader indexes positionally, so inserting a
//! column means editing both.

use rusqlite::Row as SqlRow;
use serde::Serialize;

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

/// TS `RunRow`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub home_database: String,
    pub coordinator_handle: Option<String>,
    pub coordinator_pane_key: Option<String>,
    pub consumer_generation: i64,
    /// 1 for the synthetic `run_legacy_local` Run, 0 for a real one.
    pub legacy: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub const RUN_COLUMNS: &str = "id, objective, home_database, coordinator_handle, coordinator_pane_key, consumer_generation, legacy, created_at, updated_at";

pub fn row_to_run(row: &SqlRow<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        objective: row.get(1)?,
        home_database: row.get(2)?,
        coordinator_handle: row.get(3)?,
        coordinator_pane_key: row.get(4)?,
        consumer_generation: row.get(5)?,
        legacy: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// TS `RunListPage` — a `listRuns` page plus its opaque continuation cursor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RunListPage {
    pub runs: Vec<Run>,
    /// Why renamed: `RunListPage` is composed in db.ts, not a table row, so the
    /// TS key is camelCase (`{ runs, nextCursor }`, db.ts:252).
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
}

// ---------------------------------------------------------------------------
// deliveries
// ---------------------------------------------------------------------------

/// TS `DeliveryRow`. `message_ids` is a JSON string array.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Delivery {
    pub id: String,
    pub run_id: String,
    pub consumer_generation: i64,
    pub message_ids: String,
    pub status: String,
    pub created_at: String,
    pub acknowledged_at: Option<String>,
}

pub const DELIVERY_COLUMNS: &str =
    "id, run_id, consumer_generation, message_ids, status, created_at, acknowledged_at";

pub fn row_to_delivery(row: &SqlRow<'_>) -> rusqlite::Result<Delivery> {
    Ok(Delivery {
        id: row.get(0)?,
        run_id: row.get(1)?,
        consumer_generation: row.get(2)?,
        message_ids: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        acknowledged_at: row.get(6)?,
    })
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/// The caller-supplied half of an `insertMessage`. Frozen at the shape the napi
/// `JsOrchestrationStore::insert_message` constructor uses; run-scoped inserts
/// go through [`NewRunMessage`] until the napi surface is rewired.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewMessage {
    pub id: String,
    pub from_handle: String,
    pub to_handle: String,
    pub subject: String,
    pub body: String,
    pub message_type: String,
    pub priority: String,
    pub thread_id: Option<String>,
    pub payload: Option<String>,
    pub sender_pane_key: Option<String>,
    // Why: recorded at send time so delivery can re-resolve the pane's current
    // handle after the addressed handle goes stale (#9163).
    pub recipient_pane_key: Option<String>,
}

/// A run-scoped `insertMessage`: the full upstream parameter set, including the
/// two columns [`NewMessage`] cannot carry. `run_id` defaults to the legacy Run
/// and `delivery_contract` to `current_delivery`, matching the TS `??` chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewRunMessage {
    pub id: String,
    pub run_id: String,
    pub delivery_contract: String,
    pub from_handle: String,
    pub to_handle: String,
    pub subject: String,
    pub body: String,
    pub message_type: String,
    pub priority: String,
    pub thread_id: Option<String>,
    pub payload: Option<String>,
    pub sender_pane_key: Option<String>,
    pub recipient_pane_key: Option<String>,
}

impl Default for NewRunMessage {
    fn default() -> Self {
        Self {
            id: String::new(),
            run_id: super::run_contract::LEGACY_RUN_ID.to_string(),
            delivery_contract: super::run_contract::DELIVERY_CONTRACT_CURRENT.to_string(),
            from_handle: String::new(),
            to_handle: String::new(),
            subject: String::new(),
            body: String::new(),
            message_type: "status".to_string(),
            priority: "normal".to_string(),
            thread_id: None,
            payload: None,
            sender_pane_key: None,
            recipient_pane_key: None,
        }
    }
}

/// TS `MessageRow`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Message {
    pub id: String,
    pub run_id: String,
    /// TS declares this optional; a row read through a `SELECT *` always has it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_contract: Option<String>,
    pub from_handle: String,
    pub to_handle: String,
    pub subject: String,
    pub body: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub priority: String,
    pub thread_id: Option<String>,
    pub payload: Option<String>,
    pub read: i64,
    pub sequence: i64,
    pub created_at: String,
    pub delivered_at: Option<String>,
    pub sender_pane_key: Option<String>,
    pub recipient_pane_key: Option<String>,
}

pub const MESSAGE_COLUMNS: &str = "id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, priority, thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key, recipient_pane_key";

pub fn row_to_message(row: &SqlRow<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        run_id: row.get(1)?,
        delivery_contract: row.get(2)?,
        from_handle: row.get(3)?,
        to_handle: row.get(4)?,
        subject: row.get(5)?,
        body: row.get(6)?,
        message_type: row.get(7)?,
        priority: row.get(8)?,
        thread_id: row.get(9)?,
        payload: row.get(10)?,
        read: row.get(11)?,
        sequence: row.get(12)?,
        created_at: row.get(13)?,
        delivered_at: row.get(14)?,
        sender_pane_key: row.get(15)?,
        recipient_pane_key: row.get(16)?,
    })
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/// TS `TaskRow`. `deps` is a JSON string array of task ids.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub parent_id: Option<String>,
    pub created_by_terminal_handle: Option<String>,
    pub task_title: Option<String>,
    pub display_name: Option<String>,
    pub spec: String,
    pub status: String,
    pub deps: String,
    pub result: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

pub const TASK_COLUMNS: &str = "id, run_id, parent_id, created_by_terminal_handle, task_title, display_name, spec, status, deps, result, created_at, completed_at";

pub fn row_to_task(row: &SqlRow<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        run_id: row.get(1)?,
        parent_id: row.get(2)?,
        created_by_terminal_handle: row.get(3)?,
        task_title: row.get(4)?,
        display_name: row.get(5)?,
        spec: row.get(6)?,
        status: row.get(7)?,
        deps: row.get(8)?,
        result: row.get(9)?,
        created_at: row.get(10)?,
        completed_at: row.get(11)?,
    })
}

/// A task row plus its active dispatch (LEFT JOIN), for `list_tasks_with_dispatch`.
/// `#[serde(flatten)]` inlines the task columns, then adds the two join columns —
/// matching the TS `TaskRow & { assignee_handle; dispatch_id }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskWithDispatch {
    #[serde(flatten)]
    pub task: Task,
    pub assignee_handle: Option<String>,
    pub dispatch_id: Option<String>,
}

// ---------------------------------------------------------------------------
// dispatch_contexts
// ---------------------------------------------------------------------------

/// TS `DispatchContextRow`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DispatchContext {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub contract_version: i64,
    pub launch_token_hash: Option<String>,
    pub assignee_handle: Option<String>,
    pub assignee_pane_key: Option<String>,
    pub capability_hash: Option<String>,
    pub process_incarnation: Option<String>,
    pub capability_revoked_at: Option<String>,
    pub status: String,
    pub failure_count: i64,
    pub last_failure: Option<String>,
    pub dispatched_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub last_heartbeat_at: Option<String>,
}

pub const DISPATCH_COLUMNS: &str = "id, run_id, task_id, contract_version, launch_token_hash, assignee_handle, assignee_pane_key, capability_hash, process_incarnation, capability_revoked_at, status, failure_count, last_failure, dispatched_at, completed_at, created_at, last_heartbeat_at";

pub fn row_to_dispatch(row: &SqlRow<'_>) -> rusqlite::Result<DispatchContext> {
    Ok(DispatchContext {
        id: row.get(0)?,
        run_id: row.get(1)?,
        task_id: row.get(2)?,
        contract_version: row.get(3)?,
        launch_token_hash: row.get(4)?,
        assignee_handle: row.get(5)?,
        assignee_pane_key: row.get(6)?,
        capability_hash: row.get(7)?,
        process_incarnation: row.get(8)?,
        capability_revoked_at: row.get(9)?,
        status: row.get(10)?,
        failure_count: row.get(11)?,
        last_failure: row.get(12)?,
        dispatched_at: row.get(13)?,
        completed_at: row.get(14)?,
        created_at: row.get(15)?,
        last_heartbeat_at: row.get(16)?,
    })
}

// ---------------------------------------------------------------------------
// decision_gates
// ---------------------------------------------------------------------------

/// TS `DecisionGateRow`. `options` is a JSON string array.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DecisionGate {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub question: String,
    pub options: String,
    pub status: String,
    pub resolution: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
    /// The `ask` message this gate answers, when it was opened by one. Null for
    /// gates created directly via `gateCreate`, and for every gate written by a
    /// pre-v8 build — read defensively, never assume it is present.
    pub origin_message_id: Option<String>,
}

pub const GATE_COLUMNS: &str = "id, run_id, task_id, question, options, status, resolution, created_at, resolved_at, origin_message_id";

pub fn row_to_gate(row: &SqlRow<'_>) -> rusqlite::Result<DecisionGate> {
    Ok(DecisionGate {
        id: row.get(0)?,
        run_id: row.get(1)?,
        task_id: row.get(2)?,
        question: row.get(3)?,
        options: row.get(4)?,
        status: row.get(5)?,
        resolution: row.get(6)?,
        created_at: row.get(7)?,
        resolved_at: row.get(8)?,
        origin_message_id: row.get(9)?,
    })
}

// ---------------------------------------------------------------------------
// coordinator_runs
// ---------------------------------------------------------------------------

/// TS `CoordinatorRun` — the scheduler loop's own record, distinct from [`Run`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CoordinatorRun {
    pub id: String,
    pub spec: String,
    pub status: String,
    pub coordinator_handle: String,
    pub poll_interval_ms: i64,
    pub created_at: String,
    pub completed_at: Option<String>,
    /// Stamped when the scheduler died without settling the run; drives legacy
    /// adoption provenance.
    pub scheduler_lost_at: Option<String>,
}

pub const COORDINATOR_RUN_COLUMNS: &str = "id, spec, status, coordinator_handle, poll_interval_ms, created_at, completed_at, scheduler_lost_at";

pub fn row_to_coordinator(row: &SqlRow<'_>) -> rusqlite::Result<CoordinatorRun> {
    Ok(CoordinatorRun {
        id: row.get(0)?,
        spec: row.get(1)?,
        status: row.get(2)?,
        coordinator_handle: row.get(3)?,
        poll_interval_ms: row.get(4)?,
        created_at: row.get(5)?,
        completed_at: row.get(6)?,
        scheduler_lost_at: row.get(7)?,
    })
}

// ---------------------------------------------------------------------------
// question_threads
// ---------------------------------------------------------------------------

/// TS `QuestionRow` — a durable `ask` thread keyed by its originating message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Question {
    pub message_id: String,
    pub run_id: String,
    pub dispatch_id: String,
    pub asker_handle: String,
    pub status: String,
    pub answer_message_id: Option<String>,
    pub answer_body: Option<String>,
    pub answered_by_generation: Option<i64>,
    pub created_at: String,
    pub answered_at: Option<String>,
    pub closed_at: Option<String>,
}

pub const QUESTION_COLUMNS: &str = "message_id, run_id, dispatch_id, asker_handle, status, answer_message_id, answer_body, answered_by_generation, created_at, answered_at, closed_at";

pub fn row_to_question(row: &SqlRow<'_>) -> rusqlite::Result<Question> {
    Ok(Question {
        message_id: row.get(0)?,
        run_id: row.get(1)?,
        dispatch_id: row.get(2)?,
        asker_handle: row.get(3)?,
        status: row.get(4)?,
        answer_message_id: row.get(5)?,
        answer_body: row.get(6)?,
        answered_by_generation: row.get(7)?,
        created_at: row.get(8)?,
        answered_at: row.get(9)?,
        closed_at: row.get(10)?,
    })
}

// ---------------------------------------------------------------------------
// remote_questions
// ---------------------------------------------------------------------------

/// The worker-side mirror of a question relayed from a federated home.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteQuestion {
    pub message_id: String,
    pub dispatch_id: String,
    pub status: String,
    pub answer_message_id: Option<String>,
    pub answer_body: Option<String>,
    pub created_at: String,
    pub answered_at: Option<String>,
}

pub const REMOTE_QUESTION_COLUMNS: &str = "message_id, dispatch_id, status, answer_message_id, answer_body, created_at, answered_at";

pub fn row_to_remote_question(row: &SqlRow<'_>) -> rusqlite::Result<RemoteQuestion> {
    Ok(RemoteQuestion {
        message_id: row.get(0)?,
        dispatch_id: row.get(1)?,
        status: row.get(2)?,
        answer_message_id: row.get(3)?,
        answer_body: row.get(4)?,
        created_at: row.get(5)?,
        answered_at: row.get(6)?,
    })
}

// ---------------------------------------------------------------------------
// mutation_receipts
// ---------------------------------------------------------------------------

/// TS `MutationReceiptRow` — the idempotency ledger for caller mutations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MutationReceipt {
    pub caller_fingerprint: String,
    pub request_id: String,
    pub method: String,
    pub payload_hash: String,
    pub state: String,
    pub receipt: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub const MUTATION_RECEIPT_COLUMNS: &str = "caller_fingerprint, request_id, method, payload_hash, state, receipt, created_at, updated_at";

pub fn row_to_mutation_receipt(row: &SqlRow<'_>) -> rusqlite::Result<MutationReceipt> {
    Ok(MutationReceipt {
        caller_fingerprint: row.get(0)?,
        request_id: row.get(1)?,
        method: row.get(2)?,
        payload_hash: row.get(3)?,
        state: row.get(4)?,
        receipt: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

// ---------------------------------------------------------------------------
// worker_dispatches
// ---------------------------------------------------------------------------

/// TS `WorkerDispatchRow` — the composed lifecycle state of a local worker.
/// `effects`, `residual_resources` and `start_options` are JSON TEXT.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkerDispatch {
    pub dispatch_id: String,
    pub runtime_epoch: Option<String>,
    pub state: String,
    pub stage: String,
    pub worktree_id: Option<String>,
    pub agent_terminal_handle: Option<String>,
    pub setup_state: String,
    pub effects: String,
    pub residual_resources: String,
    pub start_options: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub const WORKER_DISPATCH_COLUMNS: &str = "dispatch_id, runtime_epoch, state, stage, worktree_id, agent_terminal_handle, setup_state, effects, residual_resources, start_options, last_error, created_at, updated_at";

pub fn row_to_worker_dispatch(row: &SqlRow<'_>) -> rusqlite::Result<WorkerDispatch> {
    Ok(WorkerDispatch {
        dispatch_id: row.get(0)?,
        runtime_epoch: row.get(1)?,
        state: row.get(2)?,
        stage: row.get(3)?,
        worktree_id: row.get(4)?,
        agent_terminal_handle: row.get(5)?,
        setup_state: row.get(6)?,
        effects: row.get(7)?,
        residual_resources: row.get(8)?,
        start_options: row.get(9)?,
        last_error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

/// TS `LegacyWorkerTerminalRecoveryRow` — a dispatch/worker JOIN projection, not
/// a table. Recovery reconciles workers whose terminal vanished across a restart.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LegacyWorkerTerminalRecovery {
    pub dispatch_id: String,
    pub task_id: String,
    pub dispatch_status: String,
    pub contract_version: i64,
    pub assignee_handle: Option<String>,
    pub assignee_pane_key: Option<String>,
    pub process_incarnation: Option<String>,
    pub worker_state: String,
    pub worktree_id: Option<String>,
    pub agent_terminal_handle: Option<String>,
}

// ---------------------------------------------------------------------------
// federated_dispatches
// ---------------------------------------------------------------------------

/// TS `FederatedDispatchRow` — the home side of a dispatch running on a peer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FederatedDispatch {
    pub dispatch_id: String,
    pub environment_id: String,
    pub environment_name: String,
    pub peer_fingerprint: String,
    pub remote_runtime_epoch: Option<String>,
    pub protocol_version: i64,
    pub remote_worktree_id: Option<String>,
    pub remote_terminal_handle: Option<String>,
    pub to_home_imported_sequence: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub const FEDERATED_DISPATCH_COLUMNS: &str = "dispatch_id, environment_id, environment_name, peer_fingerprint, remote_runtime_epoch, protocol_version, remote_worktree_id, remote_terminal_handle, to_home_imported_sequence, created_at, updated_at";

pub fn row_to_federated_dispatch(row: &SqlRow<'_>) -> rusqlite::Result<FederatedDispatch> {
    Ok(FederatedDispatch {
        dispatch_id: row.get(0)?,
        environment_id: row.get(1)?,
        environment_name: row.get(2)?,
        peer_fingerprint: row.get(3)?,
        remote_runtime_epoch: row.get(4)?,
        protocol_version: row.get(5)?,
        remote_worktree_id: row.get(6)?,
        remote_terminal_handle: row.get(7)?,
        to_home_imported_sequence: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

// ---------------------------------------------------------------------------
// remote_dispatch_attachments
// ---------------------------------------------------------------------------

/// TS `RemoteDispatchAttachmentRow` — the worker side of a federated dispatch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteDispatchAttachment {
    pub dispatch_id: String,
    pub task_id: String,
    pub home_peer_fingerprint: String,
    pub protocol_version: i64,
    pub runtime_epoch: String,
    pub capability_hash: Option<String>,
    pub pane_key: Option<String>,
    pub process_incarnation: Option<String>,
    pub state: String,
    pub stage: String,
    pub worktree_id: Option<String>,
    pub terminal_handle: Option<String>,
    pub setup_state: String,
    pub effects: String,
    pub residual_resources: String,
    pub to_worker_imported_sequence: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub const REMOTE_ATTACHMENT_COLUMNS: &str = "dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch, capability_hash, pane_key, process_incarnation, state, stage, worktree_id, terminal_handle, setup_state, effects, residual_resources, to_worker_imported_sequence, last_error, created_at, updated_at";

pub fn row_to_remote_attachment(row: &SqlRow<'_>) -> rusqlite::Result<RemoteDispatchAttachment> {
    Ok(RemoteDispatchAttachment {
        dispatch_id: row.get(0)?,
        task_id: row.get(1)?,
        home_peer_fingerprint: row.get(2)?,
        protocol_version: row.get(3)?,
        runtime_epoch: row.get(4)?,
        capability_hash: row.get(5)?,
        pane_key: row.get(6)?,
        process_incarnation: row.get(7)?,
        state: row.get(8)?,
        stage: row.get(9)?,
        worktree_id: row.get(10)?,
        terminal_handle: row.get(11)?,
        setup_state: row.get(12)?,
        effects: row.get(13)?,
        residual_resources: row.get(14)?,
        to_worker_imported_sequence: row.get(15)?,
        last_error: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

// ---------------------------------------------------------------------------
// federation_relay_items
// ---------------------------------------------------------------------------

/// TS `FederationRelayItemRow` — one durable frame in a per-dispatch, per-
/// direction relay log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FederationRelayItem {
    pub dispatch_id: String,
    pub direction: String,
    pub sequence: i64,
    pub message_id: String,
    pub kind: String,
    pub payload: String,
    pub byte_count: i64,
    pub acked_at: Option<String>,
    pub created_at: String,
}

pub const FEDERATION_RELAY_COLUMNS: &str = "dispatch_id, direction, sequence, message_id, kind, payload, byte_count, acked_at, created_at";

/// `federation_relay_items.direction` values.
pub const RELAY_DIRECTION_TO_HOME: &str = "to_home";
pub const RELAY_DIRECTION_TO_WORKER: &str = "to_worker";

pub fn row_to_federation_relay_item(row: &SqlRow<'_>) -> rusqlite::Result<FederationRelayItem> {
    Ok(FederationRelayItem {
        dispatch_id: row.get(0)?,
        direction: row.get(1)?,
        sequence: row.get(2)?,
        message_id: row.get(3)?,
        kind: row.get(4)?,
        payload: row.get(5)?,
        byte_count: row.get(6)?,
        acked_at: row.get(7)?,
        created_at: row.get(8)?,
    })
}

// ---------------------------------------------------------------------------
// legacy_adoptions
// ---------------------------------------------------------------------------

/// TS `LegacyAdoptionRow` — records that the synthetic legacy Run's graph was
/// re-homed onto a real Run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LegacyAdoption {
    pub source_run_id: String,
    pub adopted_run_id: String,
    pub scheduler_state_lost: i64,
    pub adopted_at: String,
}

pub const LEGACY_ADOPTION_COLUMNS: &str =
    "source_run_id, adopted_run_id, scheduler_state_lost, adopted_at";

pub fn row_to_legacy_adoption(row: &SqlRow<'_>) -> rusqlite::Result<LegacyAdoption> {
    Ok(LegacyAdoption {
        source_run_id: row.get(0)?,
        adopted_run_id: row.get(1)?,
        scheduler_state_lost: row.get(2)?,
        adopted_at: row.get(3)?,
    })
}

// ---------------------------------------------------------------------------
// legacy_compatibility_principals
// ---------------------------------------------------------------------------

/// TS `LegacyCompatibilityPrincipalRow` — the authenticated actor a legacy CLI
/// call speaks as. Note the table has no timestamp columns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LegacyCompatibilityPrincipal {
    pub id: String,
    pub run_id: String,
    /// NULL exactly when `role = 'coordinator'` (enforced by a table CHECK).
    pub dispatch_id: Option<String>,
    pub role: String,
    pub host_scope: String,
    pub terminal_handle: String,
    pub pane_key: String,
    pub launch_token_hash: String,
    pub process_incarnation: Option<String>,
    pub status: String,
}

pub const LEGACY_PRINCIPAL_COLUMNS: &str = "id, run_id, dispatch_id, role, host_scope, terminal_handle, pane_key, launch_token_hash, process_incarnation, status";

/// `legacy_compatibility_principals.role` values.
pub const LEGACY_ROLE_WORKER: &str = "worker";
pub const LEGACY_ROLE_COORDINATOR: &str = "coordinator";

pub fn row_to_legacy_principal(row: &SqlRow<'_>) -> rusqlite::Result<LegacyCompatibilityPrincipal> {
    Ok(LegacyCompatibilityPrincipal {
        id: row.get(0)?,
        run_id: row.get(1)?,
        dispatch_id: row.get(2)?,
        role: row.get(3)?,
        host_scope: row.get(4)?,
        terminal_handle: row.get(5)?,
        pane_key: row.get(6)?,
        launch_token_hash: row.get(7)?,
        process_incarnation: row.get(8)?,
        status: row.get(9)?,
    })
}

// ---------------------------------------------------------------------------
// legacy_operation_receipts
// ---------------------------------------------------------------------------

/// TS `LegacyOperationReceiptRow` — the idempotency record for one legacy CLI
/// operation, keyed by `(principal_id, operation_key)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LegacyOperationReceipt {
    pub principal_id: String,
    pub operation_key: String,
    pub method: String,
    pub payload_hash: String,
    pub effect_id: String,
    pub response_json: String,
    pub completed_at: String,
}

pub const LEGACY_OPERATION_RECEIPT_COLUMNS: &str = "principal_id, operation_key, method, payload_hash, effect_id, response_json, completed_at";

pub fn row_to_legacy_operation_receipt(
    row: &SqlRow<'_>,
) -> rusqlite::Result<LegacyOperationReceipt> {
    Ok(LegacyOperationReceipt {
        principal_id: row.get(0)?,
        operation_key: row.get(1)?,
        method: row.get(2)?,
        payload_hash: row.get(3)?,
        effect_id: row.get(4)?,
        response_json: row.get(5)?,
        completed_at: row.get(6)?,
    })
}

// ---------------------------------------------------------------------------
// legacy_mail_receipts
// ---------------------------------------------------------------------------

/// TS `LegacyMailReceiptRow` — one principal's acknowledgement of one message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LegacyMailReceipt {
    pub principal_id: String,
    pub message_id: String,
    pub acknowledged_at: Option<String>,
}

pub const LEGACY_MAIL_RECEIPT_COLUMNS: &str = "principal_id, message_id, acknowledged_at";

pub fn row_to_legacy_mail_receipt(row: &SqlRow<'_>) -> rusqlite::Result<LegacyMailReceipt> {
    Ok(LegacyMailReceipt {
        principal_id: row.get(0)?,
        message_id: row.get(1)?,
        acknowledged_at: row.get(2)?,
    })
}
