//! Federation: the durable, per-direction relay log between a home Orca and a
//! peer environment, plus the home-side record of a dispatch running there.
//!
//! Ported from the federation section of `src/main/runtime/orchestration/db.ts`.
//! Tables: `federation_relay_items`, `federated_dispatches` (import also writes
//! `messages`, `worker_dispatches`, `remote_dispatch_attachments`).
//!
//! Private TS helpers this module also owns: `getFederationRelayItem`,
//! `settleRemoteAttachmentInRelayTransaction`.
//!
//! Ordering contract: `sequence` is dense and per `(dispatch_id, direction)`;
//! `acked_at` is a prefix acknowledgement — `acknowledgeFederationRelay` settles
//! everything through a sequence, never a single item.
//!
//! Cross-domain TS privates this module calls rather than copies:
//! `worker_dispatch::{get_worker_dispatch, settle_worker_report_in_transaction}`,
//! `messages::{insert_run_message, convert_lifecycle_message_to_rejection}`,
//! `tasks::promote_ready_tasks`.

use super::error::OrchestrationError;
use super::rows::{
    row_to_federated_dispatch, row_to_federation_relay_item, FederatedDispatch,
    FederationRelayItem, Message, NewRunMessage, WorkerDispatch, FEDERATED_DISPATCH_COLUMNS,
    FEDERATION_RELAY_COLUMNS,
};
use super::run_contract::DELIVERY_CONTRACT_CURRENT;
use super::worker_dispatch::WorkerReportSettlement;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, Connection, OptionalExtension};

/// `Buffer.byteLength(payload, 'utf8') > 64 * 1024` — the per-frame ceiling.
const RELAY_FRAME_MAX_BYTES: i64 = 64 * 1024;
/// The unacked backlog ceilings a new frame is admitted against.
const RELAY_BACKLOG_MAX_ITEMS: i64 = 256;
const RELAY_BACKLOG_MAX_BYTES: i64 = 1024 * 1024;
/// `Math.min(Math.max(limit, 1), 50)` — both list paths clamp to the same window.
const RELAY_PAGE_MAX: i64 = 50;
const RELAY_PAGE_DEFAULT: i64 = 50;

/// TS `enqueueFederationRelay(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnqueueRelayParams {
    pub dispatch_id: String,
    /// [`super::rows::RELAY_DIRECTION_TO_HOME`] or `RELAY_DIRECTION_TO_WORKER`.
    pub direction: String,
    pub kind: String,
    pub payload: String,
    /// Caller-generated id; TS mints one when absent.
    pub message_id: Option<String>,
    /// Present when this frame also settles the remote attachment
    /// (`succeeded`/`failed`).
    pub settle_remote_outcome: Option<String>,
    /// True when the frame is a question relay, so the mirror row is registered.
    pub remote_question: bool,
}

/// TS `importFederatedRelayItem(params.message)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedRelayMessage {
    pub id: String,
    pub run_id: String,
    pub from_handle: String,
    pub to_handle: String,
    pub subject: String,
    pub body: String,
    pub message_type: String,
    pub priority: String,
    pub thread_id: Option<String>,
    pub payload: Option<String>,
}

/// TS `importFederatedRelayItem(params.lifecycle)` — what the imported frame
/// means beyond delivering a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportedRelayLifecycle {
    None,
    Heartbeat { at: String },
    WorkerReport { task_id: String, outcome: String, result: String },
    Rejected { code: String, reason: String },
}

/// TS `importFederatedRelayItem(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportRelayItemParams {
    pub dispatch_id: String,
    pub sequence: i64,
    pub message: ImportedRelayMessage,
    pub lifecycle: ImportedRelayLifecycle,
}

/// TS `{ message; duplicate }` — a replayed sequence is a duplicate, not an error.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ImportedRelayItem {
    pub message: Message,
    pub duplicate: bool,
}

/// TS `reconcileFederatedWorkerStart(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FederatedWorkerStartReport {
    pub dispatch_id: String,
    /// `ready` | `failed` | `stopped` | `start_unknown`.
    pub state: String,
    pub stage: String,
    pub last_error: Option<String>,
    pub worktree_id: Option<String>,
    pub terminal_handle: Option<String>,
    pub setup_state: Option<String>,
    pub effects: Option<Vec<serde_json::Value>>,
    pub residual_resources: Option<Vec<serde_json::Value>>,
}

impl OrchestrationDb {
    /// TS `enqueueFederationRelay` — appends the next sequence for the direction.
    pub fn enqueue_federation_relay(
        &self,
        params: &EnqueueRelayParams,
    ) -> Result<FederationRelayItem, StoreError> {
        // Why: a Rust `String` is already UTF-8, so `len()` is exactly
        // `Buffer.byteLength(payload, 'utf8')`.
        let byte_count = params.payload.len() as i64;
        let message_id = match &params.message_id {
            Some(id) => id.clone(),
            None => mint_relay_message_id()?,
        };
        // Why: the per-frame ceiling is checked before BEGIN in the TS, so an
        // oversized frame never opens a writer (the backlog ceilings do).
        if byte_count > RELAY_FRAME_MAX_BYTES {
            return Err(OrchestrationError::new(
                "relay_quota_exceeded",
                "A federated orchestration message cannot exceed 64 KiB.",
            )
            .into());
        }
        let conn = self.db.connection();
        with_immediate_transaction(conn, || {
            if params.settle_remote_outcome.is_some() {
                let attachment = self.get_remote_dispatch_attachment(&params.dispatch_id)?;
                if attachment.map(|row| row.state).as_deref() != Some("ready") {
                    return Err(OrchestrationError::new(
                        "dispatch_inactive",
                        format!("Remote Dispatch {} is not active.", params.dispatch_id),
                    )
                    .into());
                }
            }

            // Why: heartbeats coalesce onto the newest unacked one — a peer that
            // stalls must not grow an unbounded liveness backlog.
            if params.kind == "heartbeat" {
                if let Some(heartbeat) =
                    newest_unacked_heartbeat(conn, &params.dispatch_id, &params.direction)?
                {
                    conn.execute(
                        "UPDATE federation_relay_items
                         SET payload = ?1, byte_count = ?2, created_at = datetime('now')
                         WHERE dispatch_id = ?3 AND direction = ?4 AND sequence = ?5",
                        params![
                            params.payload,
                            byte_count,
                            params.dispatch_id,
                            params.direction,
                            heartbeat
                        ],
                    )?;
                    return required_relay_item(
                        conn,
                        &params.dispatch_id,
                        &params.direction,
                        heartbeat,
                    );
                }
            }

            let (backlog_items, backlog_bytes): (i64, i64) = conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(byte_count), 0)
                 FROM federation_relay_items
                 WHERE dispatch_id = ?1 AND direction = ?2 AND acked_at IS NULL",
                params![params.dispatch_id, params.direction],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if backlog_items >= RELAY_BACKLOG_MAX_ITEMS
                || backlog_bytes + byte_count > RELAY_BACKLOG_MAX_BYTES
            {
                // Why: a terminal report always gets through — it overwrites the
                // OLDEST unacked heartbeat, which is the most disposable frame.
                if params.kind == "worker_done" {
                    if let Some(heartbeat) =
                        oldest_unacked_heartbeat(conn, &params.dispatch_id, &params.direction)?
                    {
                        conn.execute(
                            "UPDATE federation_relay_items
                             SET message_id = ?1, kind = ?2, payload = ?3, byte_count = ?4,
                                 created_at = datetime('now')
                             WHERE dispatch_id = ?5 AND direction = ?6 AND sequence = ?7",
                            params![
                                message_id,
                                params.kind,
                                params.payload,
                                byte_count,
                                params.dispatch_id,
                                params.direction,
                                heartbeat
                            ],
                        )?;
                        settle_remote_attachment_in_relay_transaction(
                            conn,
                            &params.dispatch_id,
                            params.settle_remote_outcome.as_deref(),
                        )?;
                        return required_relay_item(
                            conn,
                            &params.dispatch_id,
                            &params.direction,
                            heartbeat,
                        );
                    }
                }
                return Err(OrchestrationError::new(
                    "relay_quota_exceeded",
                    format!(
                        "Federated Dispatch {} has no relay capacity.",
                        params.dispatch_id
                    ),
                )
                .into());
            }

            let latest: i64 = conn.query_row(
                "SELECT COALESCE(MAX(sequence), 0)
                 FROM federation_relay_items WHERE dispatch_id = ?1 AND direction = ?2",
                params![params.dispatch_id, params.direction],
                |row| row.get(0),
            )?;
            let sequence = latest + 1;
            conn.execute(
                "INSERT INTO federation_relay_items (
                   dispatch_id, direction, sequence, message_id, kind, payload, byte_count
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    params.dispatch_id,
                    params.direction,
                    sequence,
                    message_id,
                    params.kind,
                    params.payload,
                    byte_count
                ],
            )?;
            if params.remote_question {
                conn.execute(
                    "INSERT INTO remote_questions (message_id, dispatch_id) VALUES (?1, ?2)",
                    params![message_id, params.dispatch_id],
                )?;
            }
            settle_remote_attachment_in_relay_transaction(
                conn,
                &params.dispatch_id,
                params.settle_remote_outcome.as_deref(),
            )?;
            required_relay_item(conn, &params.dispatch_id, &params.direction, sequence)
        })
    }

    /// TS `listFederationRelay` — frames after `after_sequence`, ascending, over
    /// `Math.min(Math.max(params.limit ?? 50, 1), 50)` (db.ts:4960 — the default
    /// is 50, not 100).
    pub fn list_federation_relay(
        &self,
        dispatch_id: &str,
        direction: &str,
        after_sequence: i64,
        limit: Option<i64>,
    ) -> Result<Vec<FederationRelayItem>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FEDERATION_RELAY_COLUMNS} FROM federation_relay_items
             WHERE dispatch_id = ?1 AND direction = ?2 AND sequence > ?3
             ORDER BY sequence LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params![
                dispatch_id,
                direction,
                after_sequence,
                clamp_relay_page(limit.unwrap_or(RELAY_PAGE_DEFAULT))
            ],
            row_to_federation_relay_item,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// TS `listPendingFederationRelay` — unacked frames, ascending. `limit` is
    /// clamped to `[1, 50]` (the TS parameter default is 50).
    pub fn list_pending_federation_relay(
        &self,
        dispatch_id: &str,
        direction: &str,
        limit: i64,
    ) -> Result<Vec<FederationRelayItem>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FEDERATION_RELAY_COLUMNS} FROM federation_relay_items
             WHERE dispatch_id = ?1 AND direction = ?2 AND acked_at IS NULL
             ORDER BY sequence LIMIT ?3"
        ))?;
        let rows = stmt.query_map(
            params![dispatch_id, direction, clamp_relay_page(limit)],
            row_to_federation_relay_item,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// TS `acknowledgeFederationRelay` — prefix ack through `through_sequence`.
    pub fn acknowledge_federation_relay(
        &self,
        dispatch_id: &str,
        direction: &str,
        through_sequence: i64,
    ) -> Result<(), StoreError> {
        // COALESCE keeps the first acknowledgement's stamp when a peer re-acks.
        self.db.connection().execute(
            "UPDATE federation_relay_items SET acked_at = COALESCE(acked_at, datetime('now'))
             WHERE dispatch_id = ?1 AND direction = ?2 AND sequence <= ?3",
            params![dispatch_id, direction, through_sequence],
        )?;
        Ok(())
    }

    /// TS `importFederatedRelayItem` — applies one inbound frame (message +
    /// lifecycle effect) exactly once, in a single writer.
    pub fn import_federated_relay_item(
        &self,
        params: &ImportRelayItemParams,
    ) -> Result<ImportedRelayItem, StoreError> {
        let conn = self.db.connection();
        with_immediate_transaction(conn, || {
            let Some(federated) = self.get_federated_dispatch(&params.dispatch_id)? else {
                return Err(OrchestrationError::new(
                    "dispatch_not_found",
                    format!(
                        "Federated Dispatch {} was not found.",
                        params.dispatch_id
                    ),
                )
                .into());
            };
            // Why: a replayed sequence is the peer retrying an already-applied
            // frame, so it is answered with the stored message, not an error.
            if params.sequence <= federated.to_home_imported_sequence {
                let Some(existing) = self.get_message_by_id(&params.message.id)? else {
                    return Err(OrchestrationError::new(
                        "operation_unknown",
                        format!(
                            "Federated relay sequence {} was committed without its message.",
                            params.sequence
                        ),
                    )
                    .into());
                };
                return Ok(ImportedRelayItem { message: existing, duplicate: true });
            }
            if params.sequence != federated.to_home_imported_sequence + 1 {
                return Err(OrchestrationError::new(
                    "operation_unknown",
                    format!(
                        "Federated relay for {} is not contiguous after sequence {}.",
                        params.dispatch_id, federated.to_home_imported_sequence
                    ),
                )
                .into());
            }

            let mut message = match self.get_message_by_id(&params.message.id)? {
                Some(existing) => {
                    if existing.run_id != params.message.run_id
                        || existing.to_handle != params.message.to_handle
                        || existing.message_type != params.message.message_type
                    {
                        return Err(OrchestrationError::new(
                            "request_mismatch",
                            format!(
                                "Federated relay message {} conflicts with an existing message.",
                                params.message.id
                            ),
                        )
                        .into());
                    }
                    existing
                }
                None => self.federated_insert_relay_message(&params.message)?,
            };
            if message.message_type == "question" {
                self.register_federated_question(
                    &message.id,
                    &params.message.run_id,
                    &params.dispatch_id,
                )?;
            }
            match &params.lifecycle {
                ImportedRelayLifecycle::None => {}
                ImportedRelayLifecycle::Heartbeat { at } => {
                    self.record_heartbeat(&params.dispatch_id, at)?;
                }
                ImportedRelayLifecycle::WorkerReport { task_id, outcome, result } => {
                    let settlement = self.settle_worker_report_in_transaction(
                        task_id,
                        &params.dispatch_id,
                        outcome,
                        result,
                    )?;
                    if let WorkerReportSettlement::Rejected { code, reason } = &settlement {
                        message = required_lifecycle_rejection(self, &message.id, code, reason)?;
                    }
                }
                ImportedRelayLifecycle::Rejected { code, reason } => {
                    message = required_lifecycle_rejection(self, &message.id, code, reason)?;
                }
            }
            self.set_federated_home_import_sequence(&params.dispatch_id, params.sequence)?;
            Ok(ImportedRelayItem { message, duplicate: false })
        })
    }

    /// TS `getFederatedDispatch`.
    pub fn get_federated_dispatch(
        &self,
        dispatch_id: &str,
    ) -> Result<Option<FederatedDispatch>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FEDERATED_DISPATCH_COLUMNS} FROM federated_dispatches WHERE dispatch_id = ?1"
        ))?;
        Ok(stmt.query_row([dispatch_id], row_to_federated_dispatch).optional()?)
    }

    /// TS `listActiveFederatedDispatches` — optionally scoped to one Run.
    pub fn list_active_federated_dispatches(
        &self,
        run_id: Option<&str>,
    ) -> Result<Vec<FederatedDispatch>, StoreError> {
        let conn = self.db.connection();
        let columns = FEDERATED_DISPATCH_COLUMNS
            .split(", ")
            .map(|column| format!("fd.{column}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT {columns}
             FROM federated_dispatches fd
             INNER JOIN dispatch_contexts dc ON dc.id = fd.dispatch_id
             INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
             WHERE wd.state IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
               AND (?1 IS NULL OR dc.run_id = ?1)
             ORDER BY fd.rowid"
        ))?;
        let rows = stmt.query_map(params![run_id], row_to_federated_dispatch)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// TS `updateFederatedDispatchResources` — records the peer's epoch, worktree
    /// and terminal once the remote side reports them.
    pub fn update_federated_dispatch_resources(
        &self,
        dispatch_id: &str,
        remote_runtime_epoch: &str,
        worktree_id: &str,
        terminal_handle: &str,
    ) -> Result<FederatedDispatch, StoreError> {
        self.db.connection().execute(
            "UPDATE federated_dispatches
             SET remote_runtime_epoch = ?1, remote_worktree_id = ?2, remote_terminal_handle = ?3,
                 updated_at = datetime('now')
             WHERE dispatch_id = ?4",
            params![remote_runtime_epoch, worktree_id, terminal_handle, dispatch_id],
        )?;
        self.get_federated_dispatch(dispatch_id)?.ok_or_else(|| {
            OrchestrationError::new(
                "dispatch_not_found",
                format!("Federated Dispatch {dispatch_id} was not found."),
            )
            .into()
        })
    }

    /// TS `reconcileFederatedWorkerStart` — folds the peer's start report into the
    /// home-side worker row.
    pub fn reconcile_federated_worker_start(
        &self,
        report: &FederatedWorkerStartReport,
    ) -> Result<WorkerDispatch, StoreError> {
        let conn = self.db.connection();
        with_immediate_transaction(conn, || {
            let dispatch = self.dispatch_context_by_id(&report.dispatch_id)?;
            let worker = self.get_worker_dispatch(&report.dispatch_id)?;
            let (Some(dispatch), Some(worker)) = (dispatch, worker) else {
                return Err(OrchestrationError::new(
                    "dispatch_not_found",
                    format!("Federated Dispatch {} was not found.", report.dispatch_id),
                )
                .into());
            };
            // Already past the start window: the report is stale, not an error.
            if worker.state != "starting" && worker.state != "start_unknown" {
                return Ok(worker);
            }

            if report.state == "ready" {
                // Why: an absent effects/residual list means "unchanged", and the
                // stored TEXT was itself written by JSON.stringify, so writing it
                // back verbatim is byte-identical to the TS parse/stringify round
                // trip — without depending on JSON key order.
                let effects = match &report.effects {
                    Some(effects) => json_array(effects),
                    None => worker.effects.clone(),
                };
                let residual = match &report.residual_resources {
                    Some(residual) => json_array(residual),
                    None => worker.residual_resources.clone(),
                };
                conn.execute(
                    "UPDATE worker_dispatches
                     SET state = 'ready', stage = ?1, worktree_id = COALESCE(?2, worktree_id),
                         agent_terminal_handle = COALESCE(?3, agent_terminal_handle), setup_state = ?4,
                         effects = ?5, residual_resources = ?6, last_error = NULL,
                         updated_at = datetime('now')
                     WHERE dispatch_id = ?7 AND state IN ('starting', 'start_unknown')",
                    params![
                        report.stage,
                        report.worktree_id,
                        report.terminal_handle,
                        report.setup_state.clone().unwrap_or_else(|| worker.setup_state.clone()),
                        effects,
                        residual,
                        report.dispatch_id
                    ],
                )?;
                conn.execute(
                    "UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?1 AND status = 'pending'",
                    params![report.dispatch_id],
                )?;
                conn.execute(
                    "UPDATE tasks SET status = 'dispatched', completed_at = NULL WHERE id = ?1 AND status = 'blocked'",
                    params![dispatch.task_id],
                )?;
            } else if report.state == "start_unknown" {
                conn.execute(
                    "UPDATE worker_dispatches
                     SET stage = ?1, last_error = ?2, updated_at = datetime('now')
                     WHERE dispatch_id = ?3 AND state IN ('starting', 'start_unknown')",
                    params![
                        report.stage,
                        report.last_error.clone().or_else(|| worker.last_error.clone()),
                        report.dispatch_id
                    ],
                )?;
            } else {
                let reason = report
                    .last_error
                    .clone()
                    .unwrap_or_else(|| format!("The worker server reported {}.", report.state));
                conn.execute(
                    "UPDATE worker_dispatches
                     SET state = ?1, stage = ?2, last_error = ?3, updated_at = datetime('now')
                     WHERE dispatch_id = ?4 AND state IN ('starting', 'start_unknown')",
                    params![report.state, report.stage, reason, report.dispatch_id],
                )?;
                conn.execute(
                    "UPDATE dispatch_contexts
                     SET status = 'failed', last_failure = ?1, completed_at = datetime('now'),
                         capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
                     WHERE id = ?2 AND status IN ('pending', 'dispatched')",
                    params![reason, report.dispatch_id],
                )?;
                conn.execute(
                    "UPDATE tasks SET status = 'failed', completed_at = datetime('now') WHERE id = ?1 AND status IN ('blocked', 'dispatched')",
                    params![dispatch.task_id],
                )?;
                self.close_questions_for_dispatch(&report.dispatch_id)?;
            }
            required_worker_dispatch(self, &report.dispatch_id)
        })
    }

    /// TS `reconcileFederatedWorkerStop`.
    pub fn reconcile_federated_worker_stop(
        &self,
        dispatch_id: &str,
    ) -> Result<WorkerDispatch, StoreError> {
        let conn = self.db.connection();
        with_immediate_transaction(conn, || {
            let worker = self.get_worker_dispatch(dispatch_id)?;
            let dispatch = self.dispatch_context_by_id(dispatch_id)?;
            let federated = self.get_federated_dispatch(dispatch_id)?;
            let (Some(worker), Some(_dispatch), Some(_federated)) = (worker, dispatch, federated)
            else {
                return Err(OrchestrationError::new(
                    "dispatch_not_found",
                    format!("Federated Dispatch {dispatch_id} was not found."),
                )
                .into());
            };
            if worker.state == "stopped" {
                return Ok(worker);
            }
            if worker.state != "stopping" && worker.state != "stop_unknown" {
                return Err(OrchestrationError::new(
                    "dispatch_inactive",
                    format!(
                        "Federated Dispatch {dispatch_id} cannot reconcile stop from {}.",
                        worker.state
                    ),
                )
                .into());
            }
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'stopped', stage = 'process_stopped', last_error = NULL,
                     updated_at = datetime('now')
                 WHERE dispatch_id = ?1 AND state IN ('stopping', 'stop_unknown')",
                params![dispatch_id],
            )?;
            conn.execute(
                "UPDATE dispatch_contexts
                 SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now')),
                     last_failure = 'stopped'
                 WHERE id = ?1 AND status IN ('pending', 'dispatched')",
                params![dispatch_id],
            )?;
            required_worker_dispatch(self, dispatch_id)
        })
    }

    /// TS `resumeFederatedWorkerForTerminalRelay` — reopens a settled federated
    /// worker so its terminal relay can keep streaming.
    pub fn resume_federated_worker_for_terminal_relay(
        &self,
        dispatch_id: &str,
    ) -> Result<WorkerDispatch, StoreError> {
        let conn = self.db.connection();
        with_immediate_transaction(conn, || {
            let worker = self.get_worker_dispatch(dispatch_id)?;
            let dispatch = self.dispatch_context_by_id(dispatch_id)?;
            let (Some(worker), Some(dispatch)) = (worker, dispatch) else {
                return Err(OrchestrationError::new(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} is not stopping."),
                )
                .into());
            };
            if worker.state != "stopping" {
                return Err(OrchestrationError::new(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} is not stopping."),
                )
                .into());
            }
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'ready', stage = 'remote_report_pending', updated_at = datetime('now')
                 WHERE dispatch_id = ?1 AND state = 'stopping'",
                params![dispatch_id],
            )?;
            conn.execute(
                "UPDATE tasks SET status = 'dispatched' WHERE id = ?1 AND status = 'blocked'",
                params![dispatch.task_id],
            )?;
            required_worker_dispatch(self, dispatch_id)
        })
    }

    /// TS `setFederatedHomeImportSequence` — the home's `to_home` import watermark.
    pub fn set_federated_home_import_sequence(
        &self,
        dispatch_id: &str,
        sequence: i64,
    ) -> Result<(), StoreError> {
        // Why: the `<` guard makes the watermark monotonic — replaying an older
        // sequence must not walk the import position backwards.
        self.db.connection().execute(
            "UPDATE federated_dispatches
             SET to_home_imported_sequence = ?1, updated_at = datetime('now')
             WHERE dispatch_id = ?2 AND to_home_imported_sequence < ?1",
            params![sequence, dispatch_id],
        )?;
        Ok(())
    }

    /// The run-scoped `insertMessage` for an imported relay frame: no pane keys,
    /// always the `current_delivery` contract.
    fn federated_insert_relay_message(
        &self,
        message: &ImportedRelayMessage,
    ) -> Result<Message, StoreError> {
        self.insert_run_message(&NewRunMessage {
            id: message.id.clone(),
            run_id: message.run_id.clone(),
            delivery_contract: DELIVERY_CONTRACT_CURRENT.to_string(),
            from_handle: message.from_handle.clone(),
            to_handle: message.to_handle.clone(),
            subject: message.subject.clone(),
            body: message.body.clone(),
            message_type: message.message_type.clone(),
            priority: message.priority.clone(),
            thread_id: message.thread_id.clone(),
            payload: message.payload.clone(),
            sender_pane_key: None,
            recipient_pane_key: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Federation-owned helpers
// ---------------------------------------------------------------------------

/// `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`, matching the try/catch every
/// federated writer in db.ts wraps itself in. The TS early-returns COMMIT before
/// returning a row, which is the same observable effect as returning `Ok` here.
fn with_immediate_transaction<T>(
    conn: &Connection,
    body: impl FnOnce() -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    match body() {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// TS `generateId('relay')` — `randomBytes(6).toString('hex')`.
fn mint_relay_message_id() -> Result<String, StoreError> {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes)
        .map_err(|error| StoreError::Message(format!("relay id entropy unavailable: {error}")))?;
    let mut id = String::with_capacity(6 + 12);
    id.push_str("relay_");
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    Ok(id)
}

/// `Math.min(Math.max(limit, 1), 50)`.
fn clamp_relay_page(limit: i64) -> i64 {
    limit.max(1).min(RELAY_PAGE_MAX)
}

/// `JSON.stringify(value)` for the effect/residual arrays.
fn json_array(values: &[serde_json::Value]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

/// TS private `getFederationRelayItem`.
fn relay_item(
    conn: &Connection,
    dispatch_id: &str,
    direction: &str,
    sequence: i64,
) -> Result<Option<FederationRelayItem>, StoreError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {FEDERATION_RELAY_COLUMNS} FROM federation_relay_items
         WHERE dispatch_id = ?1 AND direction = ?2 AND sequence = ?3"
    ))?;
    Ok(stmt
        .query_row(params![dispatch_id, direction, sequence], row_to_federation_relay_item)
        .optional()?)
}

/// The `as FederationRelayItemRow` cast at every TS return site: the row was just
/// written in this transaction, so its absence is a store bug, not a caller error.
fn required_relay_item(
    conn: &Connection,
    dispatch_id: &str,
    direction: &str,
    sequence: i64,
) -> Result<FederationRelayItem, StoreError> {
    relay_item(conn, dispatch_id, direction, sequence)?
        .ok_or_else(|| StoreError::Message("relay item vanished after write".into()))
}

/// TS private `settleRemoteAttachmentInRelayTransaction`.
fn settle_remote_attachment_in_relay_transaction(
    conn: &Connection,
    dispatch_id: &str,
    outcome: Option<&str>,
) -> Result<(), StoreError> {
    let Some(outcome) = outcome else {
        return Ok(());
    };
    conn.execute(
        "UPDATE remote_dispatch_attachments
         SET state = ?1, stage = 'worker_report_queued', capability_hash = NULL,
             updated_at = datetime('now')
         WHERE dispatch_id = ?2 AND state = 'ready'",
        params![if outcome == "succeeded" { "succeeded" } else { "failed" }, dispatch_id],
    )?;
    Ok(())
}

fn newest_unacked_heartbeat(
    conn: &Connection,
    dispatch_id: &str,
    direction: &str,
) -> Result<Option<i64>, StoreError> {
    Ok(conn
        .query_row(
            "SELECT sequence FROM federation_relay_items
             WHERE dispatch_id = ?1 AND direction = ?2 AND kind = 'heartbeat'
               AND acked_at IS NULL
             ORDER BY sequence DESC LIMIT 1",
            params![dispatch_id, direction],
            |row| row.get(0),
        )
        .optional()?)
}

fn oldest_unacked_heartbeat(
    conn: &Connection,
    dispatch_id: &str,
    direction: &str,
) -> Result<Option<i64>, StoreError> {
    Ok(conn
        .query_row(
            "SELECT sequence FROM federation_relay_items
             WHERE dispatch_id = ?1 AND direction = ?2 AND kind = 'heartbeat'
               AND acked_at IS NULL
             ORDER BY sequence LIMIT 1",
            params![dispatch_id, direction],
            |row| row.get(0),
        )
        .optional()?)
}

/// The non-null `getWorkerDispatch` read every federated writer ends with.
fn required_worker_dispatch(
    db: &OrchestrationDb,
    dispatch_id: &str,
) -> Result<WorkerDispatch, StoreError> {
    db.get_worker_dispatch(dispatch_id)?
        .ok_or_else(|| StoreError::Message("worker dispatch vanished after write".into()))
}

/// The `as MessageRow` cast at the TS rejection sites — the message exists
/// because the import path just read or wrote it.
fn required_lifecycle_rejection(
    db: &OrchestrationDb,
    message_id: &str,
    code: &str,
    reason: &str,
) -> Result<Message, StoreError> {
    db.convert_lifecycle_message_to_rejection(message_id, code, reason)?
        .ok_or_else(|| StoreError::Message("relay message vanished during rejection".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::rows::{RELAY_DIRECTION_TO_HOME, RELAY_DIRECTION_TO_WORKER};

    fn open() -> OrchestrationDb {
        OrchestrationDb::open_in_memory().unwrap()
    }

    /// The `code` of an `OrchestrationError` that travelled inside a `StoreError`.
    fn code_of(error: StoreError) -> String {
        let StoreError::Message(text) = error else {
            panic!("expected a coded message error, got {error:?}");
        };
        let parsed: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or_else(|_| panic!("expected a coded orchestration error, got {text}"));
        parsed["code"].as_str().expect("coded error has a code").to_string()
    }

    /// A task + dispatch context + worker row + federated record, the state every
    /// federated method assumes already exists.
    fn seed_federated(db: &OrchestrationDb, task_id: &str, dispatch_id: &str, worker_state: &str) {
        db.create_task(task_id, "spec", None, &[], None, None, None, None).unwrap();
        db.create_dispatch_context(task_id, &format!("term-{dispatch_id}"), dispatch_id, None, None)
            .unwrap();
        db.connection()
            .execute(
                "INSERT INTO worker_dispatches (dispatch_id, state, stage) VALUES (?1, ?2, 'accepted')",
                params![dispatch_id, worker_state],
            )
            .unwrap();
        db.connection()
            .execute(
                "INSERT INTO federated_dispatches (
                   dispatch_id, environment_id, environment_name, peer_fingerprint
                 ) VALUES (?1, 'env-1', 'peer one', 'fp-1')",
                params![dispatch_id],
            )
            .unwrap();
    }

    fn seed_remote_attachment(db: &OrchestrationDb, dispatch_id: &str, state: &str) {
        db.connection()
            .execute(
                "INSERT INTO remote_dispatch_attachments (
                   dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, capability_hash
                 ) VALUES (?1, 'task-remote', 'home-fp', 'epoch-1', ?2, 'cap-hash')",
                params![dispatch_id, state],
            )
            .unwrap();
    }

    fn relay(dispatch_id: &str, kind: &str, payload: &str) -> EnqueueRelayParams {
        EnqueueRelayParams {
            dispatch_id: dispatch_id.to_string(),
            direction: RELAY_DIRECTION_TO_WORKER.to_string(),
            kind: kind.to_string(),
            payload: payload.to_string(),
            message_id: None,
            settle_remote_outcome: None,
            remote_question: false,
        }
    }

    fn worker_state(db: &OrchestrationDb, dispatch_id: &str) -> String {
        db.get_worker_dispatch(dispatch_id).unwrap().unwrap().state
    }

    fn import_message(id: &str, message_type: &str) -> ImportedRelayMessage {
        ImportedRelayMessage {
            id: id.to_string(),
            run_id: crate::orchestration::run_contract::LEGACY_RUN_ID.to_string(),
            from_handle: "worker".to_string(),
            to_handle: "coordinator".to_string(),
            subject: "report".to_string(),
            body: "body".to_string(),
            message_type: message_type.to_string(),
            priority: "normal".to_string(),
            thread_id: None,
            payload: None,
        }
    }

    // ── enqueue ────────────────────────────────────────────────────────────

    #[test]
    fn enqueue_appends_a_dense_sequence_per_direction() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");

        let first = db.enqueue_federation_relay(&relay("d1", "status", "one")).unwrap();
        let second = db.enqueue_federation_relay(&relay("d1", "status", "two")).unwrap();
        assert_eq!((first.sequence, second.sequence), (1, 2));
        assert!(first.message_id.starts_with("relay_"));
        assert_eq!(first.message_id.len(), "relay_".len() + 12);

        // The other direction has its own sequence space.
        let mut inbound = relay("d1", "status", "three");
        inbound.direction = RELAY_DIRECTION_TO_HOME.to_string();
        assert_eq!(db.enqueue_federation_relay(&inbound).unwrap().sequence, 1);

        // byte_count is the UTF-8 length, not the character count.
        let wide = db.enqueue_federation_relay(&relay("d1", "status", "héllo")).unwrap();
        assert_eq!(wide.byte_count, 6);

        let listed = db.list_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 1, None).unwrap();
        assert_eq!(
            listed.iter().map(|item| item.sequence).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(listed.iter().all(|item| item.acked_at.is_none()));
    }

    #[test]
    fn enqueue_honours_a_caller_supplied_message_id_and_registers_the_question_mirror() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let mut params = relay("d1", "question", "ask");
        params.message_id = Some("msg_q1".to_string());
        params.remote_question = true;

        let item = db.enqueue_federation_relay(&params).unwrap();
        assert_eq!(item.message_id, "msg_q1");
        let mirrored: String = db
            .connection()
            .query_row(
                "SELECT status FROM remote_questions WHERE message_id = 'msg_q1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mirrored, "pending");
    }

    #[test]
    fn enqueue_rejects_a_frame_over_64_kib_without_opening_a_writer() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let oversized = "x".repeat(64 * 1024 + 1);

        let error = db.enqueue_federation_relay(&relay("d1", "status", &oversized)).unwrap_err();
        assert_eq!(code_of(error), "relay_quota_exceeded");
        assert!(db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 50).unwrap().is_empty());
        // Exactly 64 KiB is admitted.
        let at_limit = "x".repeat(64 * 1024);
        assert_eq!(db.enqueue_federation_relay(&relay("d1", "status", &at_limit)).unwrap().sequence, 1);
    }

    #[test]
    fn heartbeats_coalesce_onto_the_newest_unacked_frame() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");

        let first = db.enqueue_federation_relay(&relay("d1", "heartbeat", "beat-1")).unwrap();
        db.enqueue_federation_relay(&relay("d1", "status", "other")).unwrap();
        let second = db.enqueue_federation_relay(&relay("d1", "heartbeat", "beat-2")).unwrap();

        assert_eq!(second.sequence, first.sequence);
        assert_eq!(second.payload, "beat-2");
        assert_eq!(second.byte_count, 6);
        // The coalesced frame keeps its original message id.
        assert_eq!(second.message_id, first.message_id);
        let rows = db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 50).unwrap();
        assert_eq!(rows.len(), 2);

        // Once acked, the next heartbeat starts a fresh frame.
        db.acknowledge_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 2).unwrap();
        let third = db.enqueue_federation_relay(&relay("d1", "heartbeat", "beat-3")).unwrap();
        assert_eq!(third.sequence, 3);
    }

    #[test]
    fn a_full_backlog_rejects_new_frames_but_lets_worker_done_take_the_oldest_heartbeat() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        db.enqueue_federation_relay(&relay("d1", "heartbeat", "beat")).unwrap();
        for sequence in 2..=RELAY_BACKLOG_MAX_ITEMS {
            db.connection()
                .execute(
                    "INSERT INTO federation_relay_items (
                       dispatch_id, direction, sequence, message_id, kind, payload, byte_count
                     ) VALUES ('d1', 'to_worker', ?1, ?2, 'status', 'p', 1)",
                    params![sequence, format!("msg-{sequence}")],
                )
                .unwrap();
        }

        // At capacity an ordinary frame is refused outright.
        let error = db.enqueue_federation_relay(&relay("d1", "status", "nope")).unwrap_err();
        assert_eq!(code_of(error), "relay_quota_exceeded");

        // The terminal report overwrites the OLDEST unacked heartbeat (sequence 1).
        let mut done = relay("d1", "worker_done", "finished");
        done.message_id = Some("msg_done".to_string());
        let settled = db.enqueue_federation_relay(&done).unwrap();
        assert_eq!(settled.sequence, 1);
        assert_eq!(settled.kind, "worker_done");
        assert_eq!(settled.message_id, "msg_done");
        assert_eq!(settled.payload, "finished");

        // With no unacked heartbeat left, even worker_done is refused.
        let mut again = relay("d1", "worker_done", "finished again");
        again.message_id = Some("msg_done_2".to_string());
        assert_eq!(code_of(db.enqueue_federation_relay(&again).unwrap_err()), "relay_quota_exceeded");
    }

    #[test]
    fn a_full_byte_backlog_also_rejects() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        db.connection()
            .execute(
                "INSERT INTO federation_relay_items (
                   dispatch_id, direction, sequence, message_id, kind, payload, byte_count
                 ) VALUES ('d1', 'to_worker', 1, 'm1', 'status', 'p', ?1)",
                params![RELAY_BACKLOG_MAX_BYTES],
            )
            .unwrap();
        assert_eq!(
            code_of(db.enqueue_federation_relay(&relay("d1", "status", "x")).unwrap_err()),
            "relay_quota_exceeded"
        );
    }

    #[test]
    fn settling_the_remote_attachment_requires_a_ready_attachment() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        seed_remote_attachment(&db, "d1", "starting");
        let mut params = relay("d1", "worker_done", "done");
        params.settle_remote_outcome = Some("succeeded".to_string());

        // Not ready → rejected, and the frame is rolled back.
        assert_eq!(code_of(db.enqueue_federation_relay(&params).unwrap_err()), "dispatch_inactive");
        assert!(db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 50).unwrap().is_empty());

        db.connection()
            .execute("UPDATE remote_dispatch_attachments SET state = 'ready' WHERE dispatch_id = 'd1'", [])
            .unwrap();
        db.enqueue_federation_relay(&params).unwrap();
        let (state, stage, capability): (String, String, Option<String>) = db
            .connection()
            .query_row(
                "SELECT state, stage, capability_hash FROM remote_dispatch_attachments WHERE dispatch_id = 'd1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((state.as_str(), stage.as_str(), capability), ("succeeded", "worker_report_queued", None));
    }

    #[test]
    fn a_failed_outcome_settles_the_attachment_as_failed() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        seed_remote_attachment(&db, "d1", "ready");
        let mut params = relay("d1", "worker_done", "done");
        params.settle_remote_outcome = Some("failed".to_string());
        db.enqueue_federation_relay(&params).unwrap();
        let state: String = db
            .connection()
            .query_row(
                "SELECT state FROM remote_dispatch_attachments WHERE dispatch_id = 'd1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "failed");
    }

    // ── list / acknowledge ─────────────────────────────────────────────────

    #[test]
    fn list_paths_clamp_their_window_and_order_ascending() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        for index in 0..60 {
            db.enqueue_federation_relay(&relay("d1", "status", &format!("p{index}"))).unwrap();
        }

        // Both ends of `Math.min(Math.max(limit, 1), 50)`.
        assert_eq!(db.list_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 0, Some(0)).unwrap().len(), 1);
        assert_eq!(db.list_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 0, Some(999)).unwrap().len(), 50);
        assert_eq!(db.list_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 0, None).unwrap().len(), 50);
        assert_eq!(db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 0).unwrap().len(), 1);
        assert_eq!(db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 999).unwrap().len(), 50);

        let page = db.list_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 55, Some(50)).unwrap();
        assert_eq!(page.iter().map(|item| item.sequence).collect::<Vec<_>>(), (56..=60).collect::<Vec<_>>());
    }

    #[test]
    fn acknowledge_settles_a_prefix_and_keeps_the_first_stamp() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        for index in 0..3 {
            db.enqueue_federation_relay(&relay("d1", "status", &format!("p{index}"))).unwrap();
        }

        db.acknowledge_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 2).unwrap();
        let pending = db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 50).unwrap();
        assert_eq!(pending.iter().map(|item| item.sequence).collect::<Vec<_>>(), vec![3]);

        // COALESCE: a re-ack must not restamp an already-settled frame.
        db.connection()
            .execute("UPDATE federation_relay_items SET acked_at = '2000-01-01 00:00:00' WHERE sequence = 1", [])
            .unwrap();
        db.acknowledge_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 3).unwrap();
        let first = relay_item(db.connection(), "d1", RELAY_DIRECTION_TO_WORKER, 1).unwrap().unwrap();
        assert_eq!(first.acked_at.as_deref(), Some("2000-01-01 00:00:00"));
        assert!(db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 50).unwrap().is_empty());

        // The other direction is untouched by an ack.
        let mut inbound = relay("d1", "status", "inbound");
        inbound.direction = RELAY_DIRECTION_TO_HOME.to_string();
        db.enqueue_federation_relay(&inbound).unwrap();
        db.acknowledge_federation_relay("d1", RELAY_DIRECTION_TO_WORKER, 99).unwrap();
        assert_eq!(db.list_pending_federation_relay("d1", RELAY_DIRECTION_TO_HOME, 50).unwrap().len(), 1);
    }

    // ── federated dispatch records ─────────────────────────────────────────

    #[test]
    fn active_federated_dispatches_filter_by_worker_state_and_run() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        seed_federated(&db, "t2", "d2", "stopped");
        seed_federated(&db, "t3", "d3", "starting");
        db.connection()
            .execute(
                "INSERT INTO runs (id, objective, home_database) VALUES ('run-2', 'other', 'this_database')",
                [],
            )
            .unwrap();
        db.connection()
            .execute("UPDATE dispatch_contexts SET run_id = 'run-2' WHERE id = 'd3'", [])
            .unwrap();

        let all = db.list_active_federated_dispatches(None).unwrap();
        assert_eq!(all.iter().map(|row| row.dispatch_id.clone()).collect::<Vec<_>>(), vec!["d1", "d3"]);
        let scoped = db.list_active_federated_dispatches(Some("run-2")).unwrap();
        assert_eq!(scoped.iter().map(|row| row.dispatch_id.clone()).collect::<Vec<_>>(), vec!["d3"]);
        assert!(db.list_active_federated_dispatches(Some("run-nope")).unwrap().is_empty());
    }

    #[test]
    fn updating_resources_records_them_and_errors_when_the_record_is_absent() {
        let db = open();
        seed_federated(&db, "t1", "d1", "starting");

        let updated = db
            .update_federated_dispatch_resources("d1", "epoch-9", "wt-1", "term-remote")
            .unwrap();
        assert_eq!(updated.remote_runtime_epoch.as_deref(), Some("epoch-9"));
        assert_eq!(updated.remote_worktree_id.as_deref(), Some("wt-1"));
        assert_eq!(updated.remote_terminal_handle.as_deref(), Some("term-remote"));
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap(), updated);

        let error = db
            .update_federated_dispatch_resources("missing", "e", "w", "t")
            .unwrap_err();
        assert_eq!(code_of(error), "dispatch_not_found");
        assert!(db.get_federated_dispatch("missing").unwrap().is_none());
    }

    // ── start / stop reconciliation ────────────────────────────────────────

    fn start_report(dispatch_id: &str, state: &str) -> FederatedWorkerStartReport {
        FederatedWorkerStartReport {
            dispatch_id: dispatch_id.to_string(),
            state: state.to_string(),
            stage: "remote_started".to_string(),
            last_error: None,
            worktree_id: None,
            terminal_handle: None,
            setup_state: None,
            effects: None,
            residual_resources: None,
        }
    }

    #[test]
    fn a_ready_start_report_promotes_the_dispatch_and_task() {
        let db = open();
        seed_federated(&db, "t1", "d1", "starting");
        db.connection()
            .execute("UPDATE dispatch_contexts SET status = 'pending' WHERE id = 'd1'", [])
            .unwrap();
        db.connection()
            .execute("UPDATE tasks SET status = 'blocked', completed_at = '2000-01-01' WHERE id = 't1'", [])
            .unwrap();
        db.connection()
            .execute(
                "UPDATE worker_dispatches SET worktree_id = 'wt-old', last_error = 'earlier',
                 effects = '[{\"b\":1,\"a\":2}]', setup_state = 'pending' WHERE dispatch_id = 'd1'",
                [],
            )
            .unwrap();

        let mut report = start_report("d1", "ready");
        report.terminal_handle = Some("term-remote".to_string());
        report.residual_resources = Some(vec![serde_json::json!({"kind": "worktree"})]);
        let worker = db.reconcile_federated_worker_start(&report).unwrap();

        assert_eq!(worker.state, "ready");
        assert_eq!(worker.stage, "remote_started");
        assert_eq!(worker.last_error, None);
        // COALESCE keeps the stored worktree when the report omits it.
        assert_eq!(worker.worktree_id.as_deref(), Some("wt-old"));
        assert_eq!(worker.agent_terminal_handle.as_deref(), Some("term-remote"));
        // An absent setup_state/effects list leaves the stored value byte-identical.
        assert_eq!(worker.setup_state, "pending");
        assert_eq!(worker.effects, "[{\"b\":1,\"a\":2}]");
        assert_eq!(worker.residual_resources, "[{\"kind\":\"worktree\"}]");

        assert_eq!(db.dispatch_context_by_id("d1").unwrap().unwrap().status, "dispatched");
        let task = db.get_task("t1").unwrap().unwrap();
        assert_eq!(task.status, "dispatched");
        assert_eq!(task.completed_at, None);
    }

    #[test]
    fn a_failed_start_report_fails_the_dispatch_task_and_closes_questions() {
        let db = open();
        seed_federated(&db, "t1", "d1", "starting");
        db.connection()
            .execute(
                "INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
                 VALUES ('q1', 'run_legacy_local', 'd1', 'dispatch:d1')",
                [],
            )
            .unwrap();

        let worker = db.reconcile_federated_worker_start(&start_report("d1", "failed")).unwrap();
        assert_eq!(worker.state, "failed");
        // No lastError → the synthesized reason.
        assert_eq!(worker.last_error.as_deref(), Some("The worker server reported failed."));

        let dispatch = db.dispatch_context_by_id("d1").unwrap().unwrap();
        assert_eq!(dispatch.status, "failed");
        assert_eq!(dispatch.last_failure.as_deref(), Some("The worker server reported failed."));
        assert!(dispatch.completed_at.is_some());
        assert!(dispatch.capability_revoked_at.is_some());
        assert_eq!(db.get_task("t1").unwrap().unwrap().status, "failed");
        let question_status: String = db
            .connection()
            .query_row("SELECT status FROM question_threads WHERE message_id = 'q1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(question_status, "closed");
    }

    #[test]
    fn a_start_unknown_report_only_moves_the_stage_and_keeps_the_prior_error() {
        let db = open();
        seed_federated(&db, "t1", "d1", "starting");
        db.connection()
            .execute("UPDATE worker_dispatches SET last_error = 'earlier' WHERE dispatch_id = 'd1'", [])
            .unwrap();

        let worker = db.reconcile_federated_worker_start(&start_report("d1", "start_unknown")).unwrap();
        assert_eq!(worker.state, "starting");
        assert_eq!(worker.stage, "remote_started");
        assert_eq!(worker.last_error.as_deref(), Some("earlier"));

        let mut report = start_report("d1", "start_unknown");
        report.last_error = Some("probe timed out".to_string());
        let worker = db.reconcile_federated_worker_start(&report).unwrap();
        assert_eq!(worker.last_error.as_deref(), Some("probe timed out"));
    }

    #[test]
    fn a_start_report_outside_the_start_window_is_a_no_op_and_a_missing_one_errors() {
        let db = open();
        seed_federated(&db, "t1", "d1", "succeeded");

        let worker = db.reconcile_federated_worker_start(&start_report("d1", "ready")).unwrap();
        assert_eq!(worker.state, "succeeded");
        assert_eq!(worker.stage, "accepted");
        assert_eq!(worker_state(&db, "d1"), "succeeded");

        let error = db.reconcile_federated_worker_start(&start_report("nope", "ready")).unwrap_err();
        assert_eq!(code_of(error), "dispatch_not_found");
    }

    #[test]
    fn stop_reconciliation_settles_once_and_refuses_a_live_worker() {
        let db = open();
        seed_federated(&db, "t1", "d1", "stopping");

        let worker = db.reconcile_federated_worker_stop("d1").unwrap();
        assert_eq!((worker.state.as_str(), worker.stage.as_str()), ("stopped", "process_stopped"));
        assert_eq!(worker.last_error, None);
        let dispatch = db.dispatch_context_by_id("d1").unwrap().unwrap();
        assert_eq!(dispatch.status, "failed");
        assert_eq!(dispatch.last_failure.as_deref(), Some("stopped"));

        // Idempotent: a second reconcile returns the settled row unchanged.
        let again = db.reconcile_federated_worker_stop("d1").unwrap();
        assert_eq!(again, worker);

        seed_federated(&db, "t2", "d2", "ready");
        assert_eq!(code_of(db.reconcile_federated_worker_stop("d2").unwrap_err()), "dispatch_inactive");
        assert_eq!(code_of(db.reconcile_federated_worker_stop("nope").unwrap_err()), "dispatch_not_found");
    }

    #[test]
    fn stop_reconciliation_requires_the_federated_record() {
        let db = open();
        seed_federated(&db, "t1", "d1", "stopping");
        db.connection().execute("DELETE FROM federated_dispatches WHERE dispatch_id = 'd1'", []).unwrap();
        assert_eq!(code_of(db.reconcile_federated_worker_stop("d1").unwrap_err()), "dispatch_not_found");
        // The rejected call rolled back: the worker is still stopping.
        assert_eq!(worker_state(&db, "d1"), "stopping");
    }

    #[test]
    fn resuming_for_terminal_relay_reopens_only_a_stopping_worker() {
        let db = open();
        seed_federated(&db, "t1", "d1", "stopping");
        db.connection().execute("UPDATE tasks SET status = 'blocked' WHERE id = 't1'", []).unwrap();

        let worker = db.resume_federated_worker_for_terminal_relay("d1").unwrap();
        assert_eq!((worker.state.as_str(), worker.stage.as_str()), ("ready", "remote_report_pending"));
        assert_eq!(db.get_task("t1").unwrap().unwrap().status, "dispatched");

        // Now that it is ready, a second resume is refused.
        assert_eq!(
            code_of(db.resume_federated_worker_for_terminal_relay("d1").unwrap_err()),
            "dispatch_inactive"
        );
        assert_eq!(
            code_of(db.resume_federated_worker_for_terminal_relay("nope").unwrap_err()),
            "dispatch_inactive"
        );
    }

    // ── import watermark ───────────────────────────────────────────────────

    #[test]
    fn the_home_import_sequence_never_moves_backwards() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");

        db.set_federated_home_import_sequence("d1", 5).unwrap();
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 5);
        // Replaying an older sequence is ignored, not applied.
        db.set_federated_home_import_sequence("d1", 2).unwrap();
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 5);
        db.set_federated_home_import_sequence("d1", 5).unwrap();
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 5);
        db.set_federated_home_import_sequence("d1", 6).unwrap();
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 6);
        // An unknown dispatch is a silent no-op, matching the TS UPDATE.
        db.set_federated_home_import_sequence("nope", 1).unwrap();
    }

    // ── import ─────────────────────────────────────────────────────────────

    #[test]
    fn importing_delivers_the_message_and_advances_the_watermark() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_1", "status"),
            lifecycle: ImportedRelayLifecycle::None,
        };

        let imported = db.import_federated_relay_item(&params).unwrap();
        assert!(!imported.duplicate);
        assert_eq!(imported.message.id, "msg_1");
        assert_eq!(imported.message.to_handle, "coordinator");
        assert_eq!(imported.message.delivery_contract.as_deref(), Some("current_delivery"));
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 1);

        // Replaying the same sequence returns the stored message as a duplicate.
        let replayed = db.import_federated_relay_item(&params).unwrap();
        assert!(replayed.duplicate);
        assert_eq!(replayed.message.id, "msg_1");
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 1);
    }

    #[test]
    fn importing_refuses_a_gap_an_unknown_dispatch_and_a_conflicting_message() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let mut params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 3,
            message: import_message("msg_1", "status"),
            lifecycle: ImportedRelayLifecycle::None,
        };
        assert_eq!(code_of(db.import_federated_relay_item(&params).unwrap_err()), "operation_unknown");
        assert!(db.get_message_by_id("msg_1").unwrap().is_none());

        params.dispatch_id = "nope".to_string();
        assert_eq!(code_of(db.import_federated_relay_item(&params).unwrap_err()), "dispatch_not_found");

        // A committed sequence whose message never landed is a store inconsistency.
        db.set_federated_home_import_sequence("d1", 4).unwrap();
        params.dispatch_id = "d1".to_string();
        assert_eq!(code_of(db.import_federated_relay_item(&params).unwrap_err()), "operation_unknown");
    }

    #[test]
    fn importing_refuses_a_message_id_that_conflicts_with_a_stored_one() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let first = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_1", "status"),
            lifecycle: ImportedRelayLifecycle::None,
        };
        db.import_federated_relay_item(&first).unwrap();
        let mut conflicting = first.clone();
        conflicting.sequence = 2;
        conflicting.message.to_handle = "someone-else".to_string();
        assert_eq!(code_of(db.import_federated_relay_item(&conflicting).unwrap_err()), "request_mismatch");
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 1);
    }

    #[test]
    fn importing_a_heartbeat_stamps_dispatch_liveness() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_hb", "heartbeat"),
            lifecycle: ImportedRelayLifecycle::Heartbeat { at: "2026-01-02T03:04:05.000Z".to_string() },
        };

        db.import_federated_relay_item(&params).unwrap();
        assert_eq!(
            db.dispatch_context_by_id("d1").unwrap().unwrap().last_heartbeat_at.as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
    }

    #[test]
    fn importing_a_question_registers_the_thread() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_q", "question"),
            lifecycle: ImportedRelayLifecycle::None,
        };

        db.import_federated_relay_item(&params).unwrap();
        let (asker, status): (String, String) = db
            .connection()
            .query_row(
                "SELECT asker_handle, status FROM question_threads WHERE message_id = 'msg_q'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((asker.as_str(), status.as_str()), ("dispatch:d1", "pending"));
    }

    #[test]
    fn importing_a_worker_report_settles_the_task_dispatch_and_worker() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_done", "worker_done"),
            lifecycle: ImportedRelayLifecycle::WorkerReport {
                task_id: "t1".to_string(),
                outcome: "succeeded".to_string(),
                result: "all green".to_string(),
            },
        };

        let imported = db.import_federated_relay_item(&params).unwrap();
        // A settled report leaves the message untouched.
        assert_eq!(imported.message.subject, "report");
        assert_eq!(imported.message.priority, "normal");

        let task = db.get_task("t1").unwrap().unwrap();
        assert_eq!(task.status, "completed");
        assert_eq!(task.result.as_deref(), Some("all green"));
        let dispatch = db.dispatch_context_by_id("d1").unwrap().unwrap();
        assert_eq!(dispatch.status, "completed");
        assert!(dispatch.capability_revoked_at.is_some());
        assert_eq!(worker_state(&db, "d1"), "succeeded");
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 1);
    }

    #[test]
    fn a_rejected_worker_report_rewrites_the_lifecycle_message_but_still_advances() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_done", "worker_done"),
            lifecycle: ImportedRelayLifecycle::WorkerReport {
                task_id: "ghost-task".to_string(),
                outcome: "succeeded".to_string(),
                result: "claimed".to_string(),
            },
        };

        let imported = db.import_federated_relay_item(&params).unwrap();
        assert!(!imported.duplicate);
        assert_eq!(imported.message.subject, "Rejected worker_done: report");
        assert_eq!(imported.message.priority, "high");
        assert!(imported.message.body.starts_with("Orca rejected this worker_done: Unknown task ghost-task."));
        assert!(imported.message.body.contains("Original body:\nbody"));
        let payload: serde_json::Value =
            serde_json::from_str(imported.message.payload.as_deref().unwrap()).unwrap();
        assert_eq!(payload["_orcaLifecycleRejection"]["code"], "unknown_task");

        // The task and dispatch are untouched, but the watermark still advanced.
        assert_eq!(db.get_task("t1").unwrap().unwrap().status, "dispatched");
        assert_eq!(db.get_federated_dispatch("d1").unwrap().unwrap().to_home_imported_sequence, 1);
    }

    #[test]
    fn an_explicitly_rejected_frame_is_rewritten_with_its_own_code() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_hb", "heartbeat"),
            lifecycle: ImportedRelayLifecycle::Rejected {
                code: "sender_not_assignee".to_string(),
                reason: "the peer no longer owns this dispatch".to_string(),
            },
        };

        let imported = db.import_federated_relay_item(&params).unwrap();
        assert_eq!(imported.message.subject, "Rejected heartbeat: report");
        let payload: serde_json::Value =
            serde_json::from_str(imported.message.payload.as_deref().unwrap()).unwrap();
        assert_eq!(payload["_orcaLifecycleRejection"]["code"], "sender_not_assignee");
        assert_eq!(
            payload["_orcaLifecycleRejection"]["reason"],
            "the peer no longer owns this dispatch"
        );
    }

    #[test]
    fn a_non_lifecycle_message_is_left_alone_by_a_rejection() {
        let db = open();
        seed_federated(&db, "t1", "d1", "ready");
        let params = ImportRelayItemParams {
            dispatch_id: "d1".to_string(),
            sequence: 1,
            message: import_message("msg_status", "status"),
            lifecycle: ImportedRelayLifecycle::Rejected {
                code: "stale_dispatch".to_string(),
                reason: "stale".to_string(),
            },
        };

        let imported = db.import_federated_relay_item(&params).unwrap();
        assert_eq!(imported.message.subject, "report");
        assert_eq!(imported.message.priority, "normal");
        assert_eq!(imported.message.payload, None);
    }
}
