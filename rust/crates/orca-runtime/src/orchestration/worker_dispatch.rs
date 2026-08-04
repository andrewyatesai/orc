//! Composed worker lifecycle: the `worker_dispatches` row that tracks a local
//! agent from `starting` through `ready`/`failed` to `stopped`, alongside the
//! `dispatch_contexts` row that owns the task assignment.
//!
//! Ported from the worker section of `src/main/runtime/orchestration/db.ts`.
//! Tables: `worker_dispatches`, `dispatch_contexts`, `tasks`,
//! `federated_dispatches`, `mutation_receipts`.
//!
//! State machine (`worker_dispatches.state`): `starting` → `ready` | `failed` |
//! `start_unknown`; `ready` → `stopping` → `stopped` | `stop_unknown`;
//! `succeeded`/`failed` are report settlements; `abandoned` is terminal. The
//! `*_unknown` states exist so a crash mid-transition never claims a certainty
//! the store does not have.

use super::capability::{hash_dispatch_capability, mint_dispatch_capability_token};
use super::error::orchestration_err;
use super::mutation_receipt::MutationReceiptKey;
use super::rows::{
    row_to_worker_dispatch, DispatchContext, LegacyWorkerTerminalRecovery, Task, WorkerDispatch,
    WORKER_DISPATCH_COLUMNS,
};
use super::run_contract::CURRENT_CONTRACT_VERSION;
use super::sql_fragments::json_array_text;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension, Row as SqlRow};

/// TS `['succeeded', 'failed', 'stopped', 'abandoned']` — a worker that already
/// reached one of these has nothing left to settle.
const SETTLED_WORKER_STATES: [&str; 4] = ["succeeded", "failed", "stopped", "abandoned"];

/// The prior-worker states a retry may start from (TS `createStartingWorkerDispatch`).
const RETRYABLE_WORKER_STATES: [&str; 3] = ["failed", "stopped", "abandoned"];

/// The task states a retry may start from.
const RETRYABLE_TASK_STATES: [&str; 2] = ["failed", "blocked"];

/// TS `createStartingWorkerDispatch(params.federation)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerFederationTarget {
    pub environment_id: String,
    pub environment_name: String,
    pub peer_fingerprint: String,
    pub protocol_version: i64,
}

/// TS `createStartingWorkerDispatch(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateStartingWorkerParams {
    /// Caller-generated `ctx_<hex>` id — the dispatch id is the worker id.
    pub dispatch_id: String,
    pub task_id: String,
    /// `start_options` JSON TEXT.
    pub start_options: String,
    pub launch_token_hash: Option<String>,
    pub retry_of: Option<String>,
    pub runtime_epoch: Option<String>,
    pub federation: Option<WorkerFederationTarget>,
    pub mutation_receipt: Option<MutationReceiptKey>,
}

/// TS `{ dispatch; worker }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct StartingWorkerDispatch {
    pub dispatch: DispatchContext,
    pub worker: WorkerDispatch,
}

/// TS `recordWorkerStage(params)` — every field but `dispatch_id`/`stage` is a
/// partial update (absent leaves the column unchanged).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkerStageUpdate {
    pub dispatch_id: String,
    pub stage: String,
    pub worktree_id: Option<String>,
    pub terminal_handle: Option<String>,
    pub setup_state: Option<String>,
    pub effects: Option<Vec<serde_json::Value>>,
    pub residual_resources: Option<Vec<serde_json::Value>>,
    pub last_error: Option<String>,
    pub state: Option<String>,
}

/// TS `{ worker; changed }` — `changed` is false when the evidence is identical,
/// so the caller can skip a redundant publish.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct WorkerSetupEvidence {
    pub worker: WorkerDispatch,
    pub changed: bool,
}

/// TS `prepareStartingWorkerAuthority(params)` — binds the launched process's
/// identity to the dispatch and returns the minted capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrepareWorkerAuthorityParams {
    pub dispatch_id: String,
    pub handle: String,
    pub pane_key: String,
    pub process_incarnation: String,
    pub launch_token_hash: Option<String>,
    pub worktree_id: String,
    pub effects: Vec<serde_json::Value>,
    pub setup_state: String,
}

/// TS `beginWorkerStop` disposition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStopDisposition {
    Stopping,
    AlreadySettled,
}

/// TS `beginWorkerStop` result.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct WorkerStopStart {
    pub disposition: WorkerStopDisposition,
    pub worker: WorkerDispatch,
    pub dispatch: DispatchContext,
}

/// TS `abandonWorkerDispatch` disposition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerAbandonDisposition {
    Abandoned,
    AlreadyAbandoned,
    /// The dispatch is no longer its task's active one — abandoning is a no-op.
    Stale,
}

/// TS `abandonWorkerDispatch` result.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct WorkerAbandonment {
    pub disposition: WorkerAbandonDisposition,
    pub worker: WorkerDispatch,
}

/// TS `WorkerReportSettlement` — settled, or rejected with a machine-readable code.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum WorkerReportSettlement {
    Settled {
        /// `succeeded` | `failed`.
        outcome: String,
        duplicate: bool,
    },
    Rejected {
        /// `unknown_task` | `unknown_dispatch` | `task_dispatch_mismatch` |
        /// `inactive_dispatch` | `stale_dispatch`.
        code: String,
        reason: String,
    },
}

impl WorkerReportSettlement {
    fn rejected(code: &str, reason: String) -> Self {
        Self::Rejected { code: code.to_string(), reason }
    }
}

impl OrchestrationDb {
    /// TS `createStartingWorkerDispatch` — creates the dispatch context, the
    /// `starting` worker row, the optional federated record, and settles the
    /// mutation receipt, all in one writer.
    pub fn create_starting_worker_dispatch(
        &self,
        params: &CreateStartingWorkerParams,
    ) -> Result<StartingWorkerDispatch, StoreError> {
        self.worker_transaction(|| {
            if let Some(receipt) = params.mutation_receipt.as_ref() {
                self.worker_claim_mutation_receipt(receipt)?;
            }
            let Some(task) = self.get_task(&params.task_id)? else {
                return orchestration_err(
                    "task_not_found",
                    format!("Task {} was not found.", params.task_id),
                );
            };
            match params.retry_of.as_deref() {
                Some(retry_of) => {
                    if !self.worker_retry_is_startable(&task, retry_of)? {
                        return orchestration_err(
                            "task_not_startable",
                            format!("Task {} cannot retry from Dispatch {retry_of}.", task.id),
                        );
                    }
                }
                None if task.status != "ready" => {
                    return orchestration_err(
                        "task_not_startable",
                        format!(
                            "Task {} is {}; only a ready Task can start.",
                            task.id, task.status
                        ),
                    );
                }
                None => {}
            }

            let id = params.dispatch_id.as_str();
            let conn = self.db.connection();
            if let Some(receipt) = params.mutation_receipt.as_ref() {
                // The claim stays `pending` — only the accepted dispatch id is
                // recorded here, exactly as the TS does.
                conn.execute(
                    "UPDATE mutation_receipts
                     SET receipt = ?1, updated_at = datetime('now')
                     WHERE caller_fingerprint = ?2 AND request_id = ?3 AND state = 'pending'",
                    params![
                        serde_json::json!({ "accepted": { "dispatchId": id } }).to_string(),
                        receipt.caller_fingerprint,
                        receipt.request_id
                    ],
                )?;
            }
            conn.execute(
                "INSERT INTO dispatch_contexts (
                   id, run_id, task_id, contract_version, launch_token_hash, status, dispatched_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', datetime('now'))",
                params![
                    id,
                    task.run_id,
                    task.id,
                    CURRENT_CONTRACT_VERSION,
                    params.launch_token_hash
                ],
            )?;
            conn.execute(
                "INSERT INTO worker_dispatches (
                   dispatch_id, runtime_epoch, state, stage, start_options
                 ) VALUES (?1, ?2, 'starting', 'accepted', ?3)",
                params![id, params.runtime_epoch, params.start_options],
            )?;
            if let Some(federation) = params.federation.as_ref() {
                conn.execute(
                    "INSERT INTO federated_dispatches (
                       dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        id,
                        federation.environment_id,
                        federation.environment_name,
                        federation.peer_fingerprint,
                        federation.protocol_version
                    ],
                )?;
            }
            conn.execute(
                "UPDATE tasks SET status = 'dispatched', result = NULL, completed_at = NULL WHERE id = ?1",
                params![task.id],
            )?;
            Ok(StartingWorkerDispatch {
                dispatch: self.worker_require_dispatch(id)?,
                worker: self.worker_require(id)?,
            })
        })
    }

    /// TS `getWorkerDispatch`.
    pub fn get_worker_dispatch(
        &self,
        dispatch_id: &str,
    ) -> Result<Option<WorkerDispatch>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {WORKER_DISPATCH_COLUMNS} FROM worker_dispatches WHERE dispatch_id = ?1"
        ))?;
        Ok(stmt.query_row([dispatch_id], row_to_worker_dispatch).optional()?)
    }

    /// TS `markWorkerDispatchReady`.
    pub fn mark_worker_dispatch_ready(
        &self,
        dispatch_id: &str,
        effects: Option<&[serde_json::Value]>,
    ) -> Result<WorkerDispatch, StoreError> {
        self.worker_transaction(|| {
            let dispatch = self.dispatch_context_by_id(dispatch_id)?;
            let worker = self.get_worker_dispatch(dispatch_id)?;
            if !dispatch.is_some_and(|row| row.status == "pending")
                || !worker.is_some_and(|row| row.state == "starting")
            {
                return orchestration_err(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} is not starting."),
                );
            }
            let conn = self.db.connection();
            conn.execute(
                "UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?1",
                params![dispatch_id],
            )?;
            // COALESCE: absent effects keep whatever the start pipeline recorded.
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'ready', stage = 'input_accepted',
                     effects = COALESCE(?2, effects), updated_at = datetime('now')
                 WHERE dispatch_id = ?1",
                params![dispatch_id, effects.map(json_array_text)],
            )?;
            self.worker_require(dispatch_id)
        })
    }

    /// TS `markWorkerStartUnknown` — the start neither succeeded nor provably
    /// failed; recovery must probe before reusing the resources.
    pub fn mark_worker_start_unknown(
        &self,
        dispatch_id: &str,
        stage: &str,
        reason: &str,
    ) -> Result<WorkerDispatch, StoreError> {
        self.worker_transaction(|| {
            let Some(dispatch) = self.worker_starting_dispatch(dispatch_id)? else {
                return orchestration_err(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} is not starting."),
                );
            };
            let conn = self.db.connection();
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'start_unknown', stage = ?2, last_error = ?3,
                     updated_at = datetime('now')
                 WHERE dispatch_id = ?1",
                params![dispatch_id, stage, reason],
            )?;
            // The dispatch itself is NOT failed: an unknown start may still own
            // live resources, so only the capability is fenced.
            conn.execute(
                "UPDATE dispatch_contexts
                 SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
                 WHERE id = ?1",
                params![dispatch_id],
            )?;
            conn.execute(
                "UPDATE tasks SET status = 'blocked' WHERE id = ?1",
                params![dispatch.task_id],
            )?;
            self.close_questions_for_dispatch(dispatch_id)?;
            self.worker_require(dispatch_id)
        })
    }

    /// TS `markWorkerStopUnknown`. No transaction and no guard in the TS — the
    /// single UPDATE is gated on `state = 'stopping'`, so a worker in any other
    /// state is returned untouched. Deliberate divergence for an unknown id: the
    /// TS returns `undefined as WorkerDispatchRow` and every caller then reads
    /// `.state` off it (orchestration-worker-stop/-control), so the hole is a
    /// latent TypeError — this returns `dispatch_not_found` instead.
    pub fn mark_worker_stop_unknown(
        &self,
        dispatch_id: &str,
        reason: &str,
    ) -> Result<WorkerDispatch, StoreError> {
        self.db.connection().execute(
            "UPDATE worker_dispatches
             SET state = 'stop_unknown', stage = 'stop_outcome_unknown', last_error = ?2,
                 updated_at = datetime('now')
             WHERE dispatch_id = ?1 AND state = 'stopping'",
            params![dispatch_id, reason],
        )?;
        match self.get_worker_dispatch(dispatch_id)? {
            Some(worker) => Ok(worker),
            None => orchestration_err(
                "dispatch_not_found",
                format!("Dispatch {dispatch_id} was not found."),
            ),
        }
    }

    /// TS `failWorkerStart`.
    pub fn fail_worker_start(
        &self,
        dispatch_id: &str,
        stage: &str,
        reason: &str,
    ) -> Result<WorkerDispatch, StoreError> {
        self.worker_transaction(|| {
            let Some(dispatch) = self.worker_starting_dispatch(dispatch_id)? else {
                return orchestration_err(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} is not starting."),
                );
            };
            let conn = self.db.connection();
            conn.execute(
                "UPDATE dispatch_contexts
                 SET status = 'failed', last_failure = ?2, completed_at = datetime('now'),
                     capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
                 WHERE id = ?1",
                params![dispatch_id, reason],
            )?;
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'failed', stage = ?2, last_error = ?3, updated_at = datetime('now')
                 WHERE dispatch_id = ?1",
                params![dispatch_id, stage, reason],
            )?;
            conn.execute(
                "UPDATE tasks SET status = 'failed', completed_at = datetime('now') WHERE id = ?1",
                params![dispatch.task_id],
            )?;
            self.close_questions_for_dispatch(dispatch_id)?;
            self.worker_require(dispatch_id)
        })
    }

    /// TS `beginWorkerStop` — moves a live worker to `stopping`, or reports that
    /// it had already settled.
    pub fn begin_worker_stop(&self, dispatch_id: &str) -> Result<WorkerStopStart, StoreError> {
        self.worker_transaction(|| {
            let (Some(dispatch), Some(worker)) =
                (self.dispatch_context_by_id(dispatch_id)?, self.get_worker_dispatch(dispatch_id)?)
            else {
                return orchestration_err(
                    "dispatch_not_found",
                    format!("Dispatch {dispatch_id} was not found."),
                );
            };
            if SETTLED_WORKER_STATES.contains(&worker.state.as_str()) {
                return Ok(WorkerStopStart {
                    disposition: WorkerStopDisposition::AlreadySettled,
                    worker,
                    dispatch,
                });
            }
            if worker.state != "ready" && worker.state != "start_unknown" {
                return orchestration_err(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} cannot stop from {}.", worker.state),
                );
            }
            let conn = self.db.connection();
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'stopping', stage = 'stop_requested', updated_at = datetime('now')
                 WHERE dispatch_id = ?1 AND state IN ('ready', 'start_unknown')",
                params![dispatch_id],
            )?;
            conn.execute(
                "UPDATE dispatch_contexts
                 SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
                 WHERE id = ?1",
                params![dispatch_id],
            )?;
            conn.execute(
                "UPDATE tasks SET status = 'blocked' WHERE id = ?1",
                params![dispatch.task_id],
            )?;
            self.close_questions_for_dispatch(dispatch_id)?;
            Ok(WorkerStopStart {
                disposition: WorkerStopDisposition::Stopping,
                worker: self.worker_require(dispatch_id)?,
                dispatch: self.worker_require_dispatch(dispatch_id)?,
            })
        })
    }

    /// TS `settleWorkerStop`.
    pub fn settle_worker_stop(&self, dispatch_id: &str) -> Result<WorkerDispatch, StoreError> {
        self.worker_transaction(|| {
            let worker = self.get_worker_dispatch(dispatch_id)?;
            let dispatch = self.dispatch_context_by_id(dispatch_id)?;
            if dispatch.is_none() || !worker.is_some_and(|row| row.state == "stopping") {
                return orchestration_err(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} is not stopping."),
                );
            }
            let conn = self.db.connection();
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'stopped', stage = 'process_stopped', updated_at = datetime('now')
                 WHERE dispatch_id = ?1 AND state = 'stopping'",
                params![dispatch_id],
            )?;
            // A stop is a failure for the dispatch: the task was never completed.
            conn.execute(
                "UPDATE dispatch_contexts
                 SET status = 'failed', completed_at = datetime('now'), last_failure = 'stopped'
                 WHERE id = ?1 AND status IN ('pending', 'dispatched')",
                params![dispatch_id],
            )?;
            self.worker_require(dispatch_id)
        })
    }

    /// TS `settleWorkerReport` — the worker's own completion claim, validated
    /// against task/dispatch ownership before it settles anything.
    pub fn settle_worker_report(
        &self,
        task_id: &str,
        dispatch_id: &str,
        outcome: &str,
        result: &str,
    ) -> Result<WorkerReportSettlement, StoreError> {
        self.worker_transaction(|| {
            self.settle_worker_report_in_transaction(task_id, dispatch_id, outcome, result)
        })
    }

    /// TS private `settleWorkerReportInTransaction`.
    ///
    /// Why `pub(crate)`: the legacy-compatibility lifecycle commit and the
    /// federated relay import both settle a worker report inside their own
    /// writer, exactly as the TS calls this helper from both.
    pub(crate) fn settle_worker_report_in_transaction(
        &self,
        task_id: &str,
        dispatch_id: &str,
        outcome: &str,
        result: &str,
    ) -> Result<WorkerReportSettlement, StoreError> {
        let Some(task) = self.get_task(task_id)? else {
            return Ok(WorkerReportSettlement::rejected(
                "unknown_task",
                format!("Unknown task {task_id}."),
            ));
        };
        let Some(dispatch) = self.dispatch_context_by_id(dispatch_id)? else {
            return Ok(WorkerReportSettlement::rejected(
                "unknown_dispatch",
                format!("Unknown dispatch {dispatch_id}."),
            ));
        };
        if dispatch.task_id != task_id {
            return Ok(WorkerReportSettlement::rejected(
                "task_dispatch_mismatch",
                format!(
                    "Dispatch {dispatch_id} belongs to task {}, not {task_id}.",
                    dispatch.task_id
                ),
            ));
        }

        // Anything that is not an explicit success settles as a failure, matching
        // the TS ternaries rather than validating the outcome string.
        let settled_status = if outcome == "succeeded" { "completed" } else { "failed" };
        if dispatch.status == settled_status && task.status == settled_status {
            return Ok(WorkerReportSettlement::Settled {
                outcome: outcome.to_string(),
                duplicate: true,
            });
        }
        if dispatch.status != "dispatched" || task.status != "dispatched" {
            return Ok(WorkerReportSettlement::rejected(
                "inactive_dispatch",
                format!(
                    "inactive dispatch {dispatch_id}: it or task {task_id} is already settled."
                ),
            ));
        }
        let latest = self.get_dispatch_context(task_id)?;
        if !latest.is_some_and(|row| row.id == dispatch_id) {
            return Ok(WorkerReportSettlement::rejected(
                "stale_dispatch",
                format!(
                    "Dispatch {dispatch_id} is not the current dispatch for task {task_id}."
                ),
            ));
        }

        // Savepoint, not a nested transaction: the caller's writer stays open when
        // the guarded UPDATEs lose a race and the settlement is rejected instead.
        let conn = self.db.connection();
        conn.execute_batch("SAVEPOINT settle_worker_report")?;
        let dispatch_changes = conn.execute(
            "UPDATE dispatch_contexts
             SET status = ?2, completed_at = datetime('now'),
                 last_failure = CASE WHEN ?2 = 'failed' THEN ?3 ELSE last_failure END,
                 capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
             WHERE id = ?1 AND status = 'dispatched'",
            params![dispatch_id, settled_status, result],
        )?;
        let task_changes = conn.execute(
            "UPDATE tasks
             SET status = ?2, result = ?3, completed_at = datetime('now')
             WHERE id = ?1 AND status = 'dispatched'",
            params![task_id, settled_status, result],
        )?;
        if dispatch_changes != 1 || task_changes != 1 {
            conn.execute_batch("ROLLBACK TO settle_worker_report")?;
            conn.execute_batch("RELEASE settle_worker_report")?;
            return Ok(WorkerReportSettlement::rejected(
                "inactive_dispatch",
                format!("Dispatch {dispatch_id} changed while its worker report was settling."),
            ));
        }
        conn.execute(
            "UPDATE worker_dispatches
             SET state = ?2, stage = 'settled', updated_at = datetime('now')
             WHERE dispatch_id = ?1 AND state = 'ready'",
            params![dispatch_id, if outcome == "succeeded" { "succeeded" } else { "failed" }],
        )?;
        self.close_questions_for_dispatch(dispatch_id)?;
        if outcome == "succeeded" {
            self.promote_ready_tasks(task_id)?;
        }
        conn.execute_batch("RELEASE settle_worker_report")?;
        Ok(WorkerReportSettlement::Settled { outcome: outcome.to_string(), duplicate: false })
    }

    /// TS `abandonWorkerDispatch`.
    pub fn abandon_worker_dispatch(
        &self,
        dispatch_id: &str,
    ) -> Result<WorkerAbandonment, StoreError> {
        self.worker_transaction(|| {
            let (Some(worker), Some(dispatch)) =
                (self.get_worker_dispatch(dispatch_id)?, self.dispatch_context_by_id(dispatch_id)?)
            else {
                return orchestration_err(
                    "dispatch_not_found",
                    format!("Dispatch {dispatch_id} was not found."),
                );
            };
            if worker.state == "abandoned" {
                return Ok(WorkerAbandonment {
                    disposition: WorkerAbandonDisposition::AlreadyAbandoned,
                    worker,
                });
            }
            // A superseded dispatch no longer speaks for its task, so abandoning it
            // must not re-block a task a newer dispatch already owns.
            if !self
                .get_dispatch_context(&dispatch.task_id)?
                .is_some_and(|latest| latest.id == dispatch_id)
            {
                return Ok(WorkerAbandonment {
                    disposition: WorkerAbandonDisposition::Stale,
                    worker,
                });
            }
            if worker.state == "succeeded" {
                return orchestration_err(
                    "dispatch_inactive",
                    format!("Dispatch {dispatch_id} already succeeded and cannot be abandoned."),
                );
            }
            let conn = self.db.connection();
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = 'abandoned', stage = 'abandoned', updated_at = datetime('now')
                 WHERE dispatch_id = ?1",
                params![dispatch_id],
            )?;
            conn.execute(
                "UPDATE dispatch_contexts
                 SET status = CASE WHEN status IN ('pending', 'dispatched') THEN 'failed' ELSE status END,
                     capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')),
                     completed_at = COALESCE(completed_at, datetime('now'))
                 WHERE id = ?1",
                params![dispatch_id],
            )?;
            conn.execute(
                "UPDATE tasks SET status = 'blocked' WHERE id = ?1",
                params![dispatch.task_id],
            )?;
            self.close_questions_for_dispatch(dispatch_id)?;
            Ok(WorkerAbandonment {
                disposition: WorkerAbandonDisposition::Abandoned,
                worker: self.worker_require(dispatch_id)?,
            })
        })
    }

    /// TS `recordWorkerStage` — the partial progress update the start pipeline
    /// calls at each stage.
    pub fn record_worker_stage(
        &self,
        update: &WorkerStageUpdate,
    ) -> Result<WorkerDispatch, StoreError> {
        let Some(current) = self.get_worker_dispatch(&update.dispatch_id)? else {
            return orchestration_err(
                "dispatch_not_found",
                format!("Dispatch {} was not found.", update.dispatch_id),
            );
        };
        // Every column but `stage` is read-modify-write against the current row —
        // the TS `??` chain, not a SQL COALESCE, so an explicitly empty effects
        // array still overwrites.
        self.db.connection().execute(
            "UPDATE worker_dispatches
             SET stage = ?2, state = ?3, worktree_id = ?4, agent_terminal_handle = ?5,
                 setup_state = ?6, effects = ?7, residual_resources = ?8, last_error = ?9,
                 updated_at = datetime('now')
             WHERE dispatch_id = ?1",
            params![
                update.dispatch_id,
                update.stage,
                update.state.as_deref().unwrap_or(current.state.as_str()),
                update.worktree_id.as_deref().or(current.worktree_id.as_deref()),
                update.terminal_handle.as_deref().or(current.agent_terminal_handle.as_deref()),
                update.setup_state.as_deref().unwrap_or(current.setup_state.as_str()),
                update
                    .effects
                    .as_deref()
                    .map(json_array_text)
                    .unwrap_or_else(|| current.effects.clone()),
                update
                    .residual_resources
                    .as_deref()
                    .map(json_array_text)
                    .unwrap_or_else(|| current.residual_resources.clone()),
                update.last_error.as_deref().or(current.last_error.as_deref()),
            ],
        )?;
        self.worker_require(&update.dispatch_id)
    }

    /// TS `updateWorkerSetupEvidence`.
    pub fn update_worker_setup_evidence(
        &self,
        dispatch_id: &str,
        setup_state: &str,
        effects: &[serde_json::Value],
    ) -> Result<WorkerSetupEvidence, StoreError> {
        let Some(current) = self.get_worker_dispatch(dispatch_id)? else {
            return orchestration_err(
                "dispatch_not_found",
                format!("Dispatch {dispatch_id} was not found."),
            );
        };
        let effects = json_array_text(effects);
        if current.setup_state == setup_state && current.effects == effects {
            return Ok(WorkerSetupEvidence { worker: current, changed: false });
        }
        self.db.connection().execute(
            "UPDATE worker_dispatches
             SET setup_state = ?2, effects = ?3, updated_at = datetime('now')
             WHERE dispatch_id = ?1",
            params![dispatch_id, setup_state, effects],
        )?;
        Ok(WorkerSetupEvidence { worker: self.worker_require(dispatch_id)?, changed: true })
    }

    /// TS `prepareStartingWorkerAuthority` — returns the minted capability string.
    pub fn prepare_starting_worker_authority(
        &self,
        params: &PrepareWorkerAuthorityParams,
    ) -> Result<String, StoreError> {
        // Read the guards before opening the writer, as the TS does.
        let dispatch = self.dispatch_context_by_id(&params.dispatch_id)?;
        let worker = self.get_worker_dispatch(&params.dispatch_id)?;
        let Some(dispatch) = dispatch.filter(|row| row.status == "pending") else {
            return orchestration_err(
                "dispatch_inactive",
                format!("Dispatch {} is not starting.", params.dispatch_id),
            );
        };
        if !worker.is_some_and(|row| row.state == "starting") {
            return orchestration_err(
                "dispatch_inactive",
                format!("Dispatch {} is not starting.", params.dispatch_id),
            );
        }
        // A launch token is a one-time commitment: a second, different token means
        // two launches are racing for one dispatch.
        if let (Some(committed), Some(presented)) =
            (dispatch.launch_token_hash.as_deref(), params.launch_token_hash.as_deref())
        {
            if committed != presented {
                return orchestration_err(
                    "request_mismatch",
                    format!(
                        "Dispatch {} already has a different launch-token commitment.",
                        params.dispatch_id
                    ),
                );
            }
        }
        let capability = mint_dispatch_capability_token()?;
        self.worker_transaction(|| {
            let conn = self.db.connection();
            conn.execute(
                "UPDATE dispatch_contexts
                 SET assignee_handle = ?2, assignee_pane_key = ?3, process_incarnation = ?4,
                     capability_hash = ?5, launch_token_hash = COALESCE(launch_token_hash, ?6),
                     capability_revoked_at = NULL
                 WHERE id = ?1 AND status = 'pending'",
                params![
                    params.dispatch_id,
                    params.handle,
                    params.pane_key,
                    params.process_incarnation,
                    hash_dispatch_capability(&capability),
                    params.launch_token_hash
                ],
            )?;
            conn.execute(
                "UPDATE worker_dispatches
                 SET stage = 'authority_attached', worktree_id = ?2, agent_terminal_handle = ?3,
                     setup_state = ?4, effects = ?5, residual_resources = ?6,
                     updated_at = datetime('now')
                 WHERE dispatch_id = ?1 AND state = 'starting'",
                params![
                    params.dispatch_id,
                    params.worktree_id,
                    params.handle,
                    params.setup_state,
                    json_array_text(&params.effects),
                    json_array_text(&residual_worker_effects(&params.effects))
                ],
            )?;
            Ok(capability.clone())
        })
    }

    /// TS `reconcileMissingWorkerTerminal` — the worker's terminal is gone; settle
    /// the row rather than leave it live forever.
    pub fn reconcile_missing_worker_terminal(
        &self,
        dispatch_id: &str,
        reason: &str,
    ) -> Result<WorkerDispatch, StoreError> {
        self.worker_transaction(|| {
            let (Some(dispatch), Some(worker)) =
                (self.dispatch_context_by_id(dispatch_id)?, self.get_worker_dispatch(dispatch_id)?)
            else {
                return orchestration_err(
                    "dispatch_not_found",
                    format!("Dispatch {dispatch_id} was not found."),
                );
            };
            if SETTLED_WORKER_STATES.contains(&worker.state.as_str()) {
                return Ok(worker);
            }

            let active_dispatch = dispatch.status == "pending" || dispatch.status == "dispatched";
            // A stop that was already in flight got what it asked for: the worker
            // settles as `stopped`, and the task keeps whatever the stop left it.
            let stop_was_pending = worker.state == "stopping" || worker.state == "stop_unknown";
            let conn = self.db.connection();
            if active_dispatch {
                let failure_count = dispatch.failure_count + 1;
                let dispatch_status =
                    if failure_count >= 3 { "circuit_broken" } else { "failed" };
                conn.execute(
                    "UPDATE dispatch_contexts
                     SET status = ?2, failure_count = ?3, last_failure = ?4,
                         completed_at = datetime('now'),
                         capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
                     WHERE id = ?1 AND status IN ('pending', 'dispatched')",
                    params![dispatch_id, dispatch_status, failure_count, reason],
                )?;
                if !stop_was_pending {
                    let task_status =
                        if dispatch_status == "circuit_broken" { "failed" } else { "ready" };
                    conn.execute(
                        "UPDATE tasks
                         SET status = ?2,
                             completed_at = CASE WHEN ?2 = 'failed' THEN datetime('now') ELSE NULL END
                         WHERE id = ?1 AND status IN ('dispatched', 'blocked')",
                        params![dispatch.task_id, task_status],
                    )?;
                }
                self.close_questions_for_dispatch(dispatch_id)?;
            }
            conn.execute(
                "UPDATE worker_dispatches
                 SET state = ?2, stage = 'terminal_missing', last_error = ?3,
                     updated_at = datetime('now')
                 WHERE dispatch_id = ?1",
                params![
                    dispatch_id,
                    if stop_was_pending { "stopped" } else { "abandoned" },
                    reason
                ],
            )?;
            self.worker_require(dispatch_id)
        })
    }

    /// TS `listLegacyWorkerTerminalRecoveryRows` — the dispatch/worker join the
    /// startup recovery sweep walks.
    pub fn list_legacy_worker_terminal_recovery_rows(
        &self,
    ) -> Result<Vec<LegacyWorkerTerminalRecovery>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT dc.id AS dispatch_id, dc.task_id, dc.status AS dispatch_status,
                    dc.contract_version, dc.assignee_handle, dc.assignee_pane_key,
                    dc.process_incarnation, wd.state AS worker_state, wd.worktree_id,
                    wd.agent_terminal_handle
             FROM dispatch_contexts dc
             INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
             WHERE wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
             ORDER BY dc.rowid",
        )?;
        let rows = stmt.query_map([], worker_recovery_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── private helpers ──

    /// The TS `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` envelope. COMMIT sits
    /// inside the fallible path so a failed commit rolls back too.
    fn worker_transaction<T>(
        &self,
        body: impl FnOnce() -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match body().and_then(|value| self.db.exec("COMMIT").map(|()| value)) {
            Ok(value) => Ok(value),
            Err(error) => {
                self.db.exec("ROLLBACK")?;
                Err(error)
            }
        }
    }

    /// The dispatch context of a worker that is still `starting`, or `None` when
    /// either row is missing or the worker has moved on (TS
    /// `!dispatch || !worker || worker.state !== 'starting'`).
    fn worker_starting_dispatch(
        &self,
        dispatch_id: &str,
    ) -> Result<Option<DispatchContext>, StoreError> {
        let dispatch = self.dispatch_context_by_id(dispatch_id)?;
        let worker = self.get_worker_dispatch(dispatch_id)?;
        Ok(dispatch.filter(|_| worker.is_some_and(|row| row.state == "starting")))
    }

    /// The `as WorkerDispatchRow` cast the TS makes after a guarded read: the row
    /// is present by construction, so its absence is a store bug, not a rejection.
    fn worker_require(&self, dispatch_id: &str) -> Result<WorkerDispatch, StoreError> {
        self.get_worker_dispatch(dispatch_id)?.ok_or_else(|| {
            StoreError::Message(format!("worker dispatch {dispatch_id} vanished mid-writer"))
        })
    }

    /// The `as DispatchContextRow` twin of [`Self::worker_require`].
    fn worker_require_dispatch(&self, dispatch_id: &str) -> Result<DispatchContext, StoreError> {
        self.dispatch_context_by_id(dispatch_id)?.ok_or_else(|| {
            StoreError::Message(format!("dispatch context {dispatch_id} vanished mid-writer"))
        })
    }

    /// The receipt half of `createStartingWorkerDispatch`: a request id already on
    /// the ledger never starts a second worker, and a changed payload under that
    /// id is a mismatch rather than a fresh acceptance.
    fn worker_claim_mutation_receipt(
        &self,
        receipt: &MutationReceiptKey,
    ) -> Result<(), StoreError> {
        if let Some(existing) =
            self.get_mutation_receipt(&receipt.caller_fingerprint, &receipt.request_id)?
        {
            if existing.method != receipt.method || existing.payload_hash != receipt.payload_hash {
                return orchestration_err(
                    "request_mismatch",
                    format!(
                        "Mutation request {} was already used with different input.",
                        receipt.request_id
                    ),
                );
            }
            return orchestration_err(
                "operation_unknown",
                format!(
                    "Mutation {} already has a durable acceptance record.",
                    receipt.request_id
                ),
            );
        }
        self.ensure_mutation_receipt_capacity()?;
        self.db.connection().execute(
            "INSERT INTO mutation_receipts (
               caller_fingerprint, request_id, method, payload_hash, state
             ) VALUES (?1, ?2, ?3, ?4, 'pending')",
            params![
                receipt.caller_fingerprint,
                receipt.request_id,
                receipt.method,
                receipt.payload_hash
            ],
        )?;
        Ok(())
    }

    /// May `task` start again from the dispatch `retry_of`? Only when that prior
    /// dispatch is this task's newest, its worker settled without succeeding, and
    /// the task itself is failed/blocked.
    fn worker_retry_is_startable(&self, task: &Task, retry_of: &str) -> Result<bool, StoreError> {
        let (Some(prior), Some(prior_worker)) =
            (self.dispatch_context_by_id(retry_of)?, self.get_worker_dispatch(retry_of)?)
        else {
            return Ok(false);
        };
        Ok(prior.task_id == task.id
            && self.get_dispatch_context(&task.id)?.is_some_and(|latest| latest.id == prior.id)
            && RETRYABLE_WORKER_STATES.contains(&prior_worker.state.as_str())
            && RETRYABLE_TASK_STATES.contains(&task.status.as_str()))
    }

}

/// The `listLegacyWorkerTerminalRecoveryRows` projection: a dispatch/worker join,
/// not a table, so its reader lives with the query instead of in `rows`.
fn worker_recovery_row(row: &SqlRow<'_>) -> rusqlite::Result<LegacyWorkerTerminalRecovery> {
    Ok(LegacyWorkerTerminalRecovery {
        dispatch_id: row.get(0)?,
        task_id: row.get(1)?,
        dispatch_status: row.get(2)?,
        contract_version: row.get(3)?,
        assignee_handle: row.get(4)?,
        assignee_pane_key: row.get(5)?,
        process_incarnation: row.get(6)?,
        worker_state: row.get(7)?,
        worktree_id: row.get(8)?,
        agent_terminal_handle: row.get(9)?,
    })
}

/// The effects worth remembering as residual resources: anything the start
/// pipeline created, plus a reused agent terminal (TS filter on
/// `action.startsWith('created') || action === 'reused_agent_terminal'`).
fn residual_worker_effects(effects: &[serde_json::Value]) -> Vec<serde_json::Value> {
    effects
        .iter()
        .filter(|effect| {
            effect.get("action").and_then(serde_json::Value::as_str).is_some_and(|action| {
                action.starts_with("created") || action == "reused_agent_terminal"
            })
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::error::ORCHESTRATION_ERROR_MARKER;
    use serde_json::json;

    const TASK: &str = "task-1";
    const DISPATCH: &str = "ctx_1";

    /// A ready task plus a `starting` worker on it — the shape every lifecycle
    /// method starts from.
    fn started(db: &OrchestrationDb) -> StartingWorkerDispatch {
        db.create_task(TASK, "ship it", None, &[], None, None, None, None).unwrap();
        db.create_starting_worker_dispatch(&start_params(DISPATCH, TASK)).unwrap()
    }

    fn start_params(dispatch_id: &str, task_id: &str) -> CreateStartingWorkerParams {
        CreateStartingWorkerParams {
            dispatch_id: dispatch_id.to_string(),
            task_id: task_id.to_string(),
            start_options: r#"{"agent":"claude"}"#.to_string(),
            launch_token_hash: None,
            retry_of: None,
            runtime_epoch: None,
            federation: None,
            mutation_receipt: None,
        }
    }

    /// Drive a worker all the way to `ready` (dispatch `dispatched`, task `dispatched`).
    fn ready(db: &OrchestrationDb) -> WorkerDispatch {
        started(db);
        db.mark_worker_dispatch_ready(DISPATCH, None).unwrap()
    }

    fn assert_coded(error: StoreError, code: &str) -> serde_json::Value {
        let StoreError::Message(text) = error else {
            panic!("expected a coded message error, got {error:?}");
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed[ORCHESTRATION_ERROR_MARKER], json!(true));
        assert_eq!(parsed["code"], code);
        parsed
    }

    fn task_status(db: &OrchestrationDb, id: &str) -> String {
        db.get_task(id).unwrap().unwrap().status
    }

    fn worker(db: &OrchestrationDb, id: &str) -> WorkerDispatch {
        db.get_worker_dispatch(id).unwrap().unwrap()
    }

    fn dispatch(db: &OrchestrationDb, id: &str) -> DispatchContext {
        db.dispatch_context_by_id(id).unwrap().unwrap()
    }

    #[test]
    fn create_starts_the_worker_and_dispatches_its_task() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.create_task(TASK, "ship it", None, &[], None, None, None, None).unwrap();
        let mut params = start_params(DISPATCH, TASK);
        params.launch_token_hash = Some("lt-hash".to_string());
        params.runtime_epoch = Some("epoch-1".to_string());
        params.federation = Some(WorkerFederationTarget {
            environment_id: "env-1".to_string(),
            environment_name: "peer".to_string(),
            peer_fingerprint: "fp".to_string(),
            protocol_version: 3,
        });

        let created = db.create_starting_worker_dispatch(&params).unwrap();

        assert_eq!(created.dispatch.id, DISPATCH);
        assert_eq!(created.dispatch.task_id, TASK);
        assert_eq!(created.dispatch.run_id, "run_legacy_local");
        assert_eq!(created.dispatch.status, "pending");
        assert_eq!(created.dispatch.contract_version, CURRENT_CONTRACT_VERSION);
        assert_eq!(created.dispatch.launch_token_hash.as_deref(), Some("lt-hash"));
        assert!(created.dispatch.dispatched_at.is_some());
        assert_eq!(created.worker.state, "starting");
        assert_eq!(created.worker.stage, "accepted");
        assert_eq!(created.worker.runtime_epoch.as_deref(), Some("epoch-1"));
        assert_eq!(created.worker.start_options, r#"{"agent":"claude"}"#);
        assert_eq!(created.worker.effects, "[]");
        assert_eq!(created.worker.residual_resources, "[]");
        assert_eq!(created.worker.setup_state, "not_applicable");
        assert_eq!(task_status(&db, TASK), "dispatched");

        let federated = db
            .connection()
            .query_row(
                "SELECT environment_name, protocol_version FROM federated_dispatches WHERE dispatch_id = ?1",
                params![DISPATCH],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
        assert_eq!(federated, ("peer".to_string(), 3));
    }

    #[test]
    fn create_refuses_an_unknown_or_unready_task_and_rolls_back() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        let missing = db.create_starting_worker_dispatch(&start_params(DISPATCH, "nope")).unwrap_err();
        assert_eq!(assert_coded(missing, "task_not_found")["message"], "Task nope was not found.");

        // A task with an unmet dep is `pending`, not `ready`.
        db.create_task("dep", "first", None, &[], None, None, None, None).unwrap();
        db.create_task(TASK, "second", None, &["dep"], None, None, None, None).unwrap();
        let unready =
            db.create_starting_worker_dispatch(&start_params(DISPATCH, TASK)).unwrap_err();
        assert_eq!(
            assert_coded(unready, "task_not_startable")["message"],
            "Task task-1 is pending; only a ready Task can start."
        );
        assert!(db.dispatch_context_by_id(DISPATCH).unwrap().is_none());
        assert!(db.get_worker_dispatch(DISPATCH).unwrap().is_none());
        assert_eq!(task_status(&db, TASK), "pending");
        // The rolled-back writer is still usable.
        assert!(db.get_task(TASK).unwrap().is_some());
    }

    #[test]
    fn create_retry_requires_the_task_s_newest_settled_dispatch() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);

        // The prior worker is still starting: nothing to retry from.
        let mut retry = start_params("ctx_2", TASK);
        retry.retry_of = Some(DISPATCH.to_string());
        let live = db.create_starting_worker_dispatch(&retry).unwrap_err();
        assert_eq!(
            assert_coded(live, "task_not_startable")["message"],
            "Task task-1 cannot retry from Dispatch ctx_1."
        );

        // Settle it: worker `failed`, task `failed`.
        db.fail_worker_start(DISPATCH, "worktree", "disk full").unwrap();
        let retried = db.create_starting_worker_dispatch(&retry).unwrap();
        assert_eq!(retried.worker.state, "starting");
        assert_eq!(task_status(&db, TASK), "dispatched");

        // An unknown prior, and a prior belonging to another task, both refuse.
        let mut unknown = start_params("ctx_3", TASK);
        unknown.retry_of = Some("ctx_missing".to_string());
        assert_coded(
            db.create_starting_worker_dispatch(&unknown).unwrap_err(),
            "task_not_startable",
        );
        db.create_task("task-2", "other", None, &[], None, None, None, None).unwrap();
        let mut foreign = start_params("ctx_4", "task-2");
        foreign.retry_of = Some(DISPATCH.to_string());
        assert_coded(
            db.create_starting_worker_dispatch(&foreign).unwrap_err(),
            "task_not_startable",
        );
    }

    #[test]
    fn create_records_its_mutation_receipt_and_refuses_a_replay() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.create_task(TASK, "ship it", None, &[], None, None, None, None).unwrap();
        let mut params = start_params(DISPATCH, TASK);
        params.mutation_receipt = Some(MutationReceiptKey {
            caller_fingerprint: "peer-a".to_string(),
            request_id: "req-1".to_string(),
            method: "startWorker".to_string(),
            payload_hash: "hash-1".to_string(),
        });

        db.create_starting_worker_dispatch(&params).unwrap();
        let stored = db.get_mutation_receipt("peer-a", "req-1").unwrap().unwrap();
        assert_eq!(stored.state, "pending");
        assert_eq!(stored.receipt.as_deref(), Some(r#"{"accepted":{"dispatchId":"ctx_1"}}"#));

        // The same request id never starts a second worker.
        let mut replay = params.clone();
        replay.dispatch_id = "ctx_2".to_string();
        let replayed = db.create_starting_worker_dispatch(&replay).unwrap_err();
        assert_eq!(
            assert_coded(replayed, "operation_unknown")["message"],
            "Mutation req-1 already has a durable acceptance record."
        );
        assert!(db.get_worker_dispatch("ctx_2").unwrap().is_none());

        // Same id, different payload is a mismatch rather than an acceptance.
        let mut drifted = replay.clone();
        drifted.mutation_receipt.as_mut().unwrap().payload_hash = "hash-2".to_string();
        assert_coded(db.create_starting_worker_dispatch(&drifted).unwrap_err(), "request_mismatch");
    }

    #[test]
    fn ready_dispatches_the_context_and_only_from_starting() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);

        let marked = db.mark_worker_dispatch_ready(DISPATCH, Some(&[json!({"action":"created_worktree"})])).unwrap();
        assert_eq!(marked.state, "ready");
        assert_eq!(marked.stage, "input_accepted");
        assert_eq!(marked.effects, r#"[{"action":"created_worktree"}]"#);
        assert_eq!(dispatch(&db, DISPATCH).status, "dispatched");

        // Second call: no longer starting.
        let again = db.mark_worker_dispatch_ready(DISPATCH, None).unwrap_err();
        assert_eq!(
            assert_coded(again, "dispatch_inactive")["message"],
            "Dispatch ctx_1 is not starting."
        );
        assert_coded(db.mark_worker_dispatch_ready("ctx_missing", None).unwrap_err(), "dispatch_inactive");
    }

    #[test]
    fn ready_without_effects_keeps_the_recorded_ones() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);
        db.record_worker_stage(&WorkerStageUpdate {
            dispatch_id: DISPATCH.to_string(),
            stage: "worktree_ready".to_string(),
            effects: Some(vec![json!({"action":"created_worktree"})]),
            ..Default::default()
        })
        .unwrap();

        let marked = db.mark_worker_dispatch_ready(DISPATCH, None).unwrap();
        assert_eq!(marked.effects, r#"[{"action":"created_worktree"}]"#);
    }

    #[test]
    fn fail_start_settles_dispatch_task_and_revokes_the_capability() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);

        let failed = db.fail_worker_start(DISPATCH, "terminal", "spawn refused").unwrap();
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.stage, "terminal");
        assert_eq!(failed.last_error.as_deref(), Some("spawn refused"));
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.status, "failed");
        assert_eq!(row.last_failure.as_deref(), Some("spawn refused"));
        assert!(row.completed_at.is_some());
        assert!(row.capability_revoked_at.is_some());
        let task = db.get_task(TASK).unwrap().unwrap();
        assert_eq!(task.status, "failed");
        assert!(task.completed_at.is_some());

        // Only a starting worker can fail its start.
        assert_coded(
            db.fail_worker_start(DISPATCH, "terminal", "again").unwrap_err(),
            "dispatch_inactive",
        );
    }

    #[test]
    fn start_unknown_blocks_the_task_without_failing_the_dispatch() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);

        let unknown = db.mark_worker_start_unknown(DISPATCH, "terminal", "no reply").unwrap();
        assert_eq!(unknown.state, "start_unknown");
        assert_eq!(unknown.stage, "terminal");
        assert_eq!(unknown.last_error.as_deref(), Some("no reply"));
        let row = dispatch(&db, DISPATCH);
        // The dispatch is fenced but NOT failed — its resources may still be live.
        assert_eq!(row.status, "pending");
        assert!(row.capability_revoked_at.is_some());
        assert!(row.completed_at.is_none());
        assert_eq!(task_status(&db, TASK), "blocked");

        assert_coded(
            db.mark_worker_start_unknown(DISPATCH, "terminal", "again").unwrap_err(),
            "dispatch_inactive",
        );
    }

    #[test]
    fn settling_a_worker_closes_only_its_own_pending_questions() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);
        let open_question = |message_id: &str, dispatch_id: &str| {
            db.connection()
                .execute(
                    "INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status)
                     VALUES (?1, 'run_legacy_local', ?2, 'term-1', 'pending')",
                    params![message_id, dispatch_id],
                )
                .unwrap();
        };
        open_question("msg-1", DISPATCH);
        open_question("msg-2", "ctx_other");

        db.fail_worker_start(DISPATCH, "terminal", "spawn refused").unwrap();

        let question = |message_id: &str| {
            db.get_question(message_id).unwrap().unwrap()
        };
        assert_eq!(question("msg-1").status, "closed");
        assert!(question("msg-1").closed_at.is_some());
        // Another dispatch's thread is untouched.
        assert_eq!(question("msg-2").status, "pending");
    }

    #[test]
    fn stop_moves_ready_to_stopping_then_stopped() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);

        let begun = db.begin_worker_stop(DISPATCH).unwrap();
        assert_eq!(begun.disposition, WorkerStopDisposition::Stopping);
        assert_eq!(begun.worker.state, "stopping");
        assert_eq!(begun.worker.stage, "stop_requested");
        assert!(begun.dispatch.capability_revoked_at.is_some());
        assert_eq!(task_status(&db, TASK), "blocked");

        let stopped = db.settle_worker_stop(DISPATCH).unwrap();
        assert_eq!(stopped.state, "stopped");
        assert_eq!(stopped.stage, "process_stopped");
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.status, "failed");
        assert_eq!(row.last_failure.as_deref(), Some("stopped"));
        assert!(row.completed_at.is_some());

        // A settled worker reports rather than throws, and returns the settled row.
        let again = db.begin_worker_stop(DISPATCH).unwrap();
        assert_eq!(again.disposition, WorkerStopDisposition::AlreadySettled);
        assert_eq!(again.worker.state, "stopped");
        // …and settling a stop twice is refused.
        assert_coded(db.settle_worker_stop(DISPATCH).unwrap_err(), "dispatch_inactive");
    }

    #[test]
    fn stop_refuses_a_starting_worker_and_an_unknown_dispatch() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);

        let too_early = db.begin_worker_stop(DISPATCH).unwrap_err();
        assert_eq!(
            assert_coded(too_early, "dispatch_inactive")["message"],
            "Dispatch ctx_1 cannot stop from starting."
        );
        let missing = db.begin_worker_stop("ctx_missing").unwrap_err();
        assert_eq!(
            assert_coded(missing, "dispatch_not_found")["message"],
            "Dispatch ctx_missing was not found."
        );
        // An unknown start may be stopped — that is the whole point of the state.
        db.mark_worker_start_unknown(DISPATCH, "terminal", "no reply").unwrap();
        assert_eq!(
            db.begin_worker_stop(DISPATCH).unwrap().disposition,
            WorkerStopDisposition::Stopping
        );
    }

    #[test]
    fn stop_unknown_only_moves_a_stopping_worker() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);

        // Not stopping yet: the guarded UPDATE is a no-op and the row comes back as is.
        let untouched = db.mark_worker_stop_unknown(DISPATCH, "no exit code").unwrap();
        assert_eq!(untouched.state, "ready");
        assert_eq!(untouched.last_error, None);

        db.begin_worker_stop(DISPATCH).unwrap();
        let unknown = db.mark_worker_stop_unknown(DISPATCH, "no exit code").unwrap();
        assert_eq!(unknown.state, "stop_unknown");
        assert_eq!(unknown.stage, "stop_outcome_unknown");
        assert_eq!(unknown.last_error.as_deref(), Some("no exit code"));

        assert_coded(db.mark_worker_stop_unknown("ctx_missing", "x").unwrap_err(), "dispatch_not_found");
    }

    #[test]
    fn report_settles_the_task_then_reports_a_duplicate() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);

        let settled = db.settle_worker_report(TASK, DISPATCH, "succeeded", "done").unwrap();
        assert_eq!(
            settled,
            WorkerReportSettlement::Settled { outcome: "succeeded".to_string(), duplicate: false }
        );
        let task = db.get_task(TASK).unwrap().unwrap();
        assert_eq!(task.status, "completed");
        assert_eq!(task.result.as_deref(), Some("done"));
        assert!(task.completed_at.is_some());
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.status, "completed");
        assert_eq!(row.last_failure, None);
        assert!(row.capability_revoked_at.is_some());
        let settled_worker = worker(&db, DISPATCH);
        assert_eq!(settled_worker.state, "succeeded");
        assert_eq!(settled_worker.stage, "settled");

        let replay = db.settle_worker_report(TASK, DISPATCH, "succeeded", "done").unwrap();
        assert_eq!(
            replay,
            WorkerReportSettlement::Settled { outcome: "succeeded".to_string(), duplicate: true }
        );
    }

    #[test]
    fn report_failure_records_the_result_as_the_dispatch_failure() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);

        db.settle_worker_report(TASK, DISPATCH, "failed", "tests red").unwrap();
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.status, "failed");
        assert_eq!(row.last_failure.as_deref(), Some("tests red"));
        assert_eq!(task_status(&db, TASK), "failed");
        assert_eq!(worker(&db, DISPATCH).state, "failed");
        // A failed settlement never promotes dependents.
        assert_eq!(
            db.settle_worker_report(TASK, DISPATCH, "failed", "tests red").unwrap(),
            WorkerReportSettlement::Settled { outcome: "failed".to_string(), duplicate: true }
        );
    }

    #[test]
    fn report_rejects_unknown_mismatched_inactive_and_stale_claims() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);
        db.create_task("task-2", "other", None, &[], None, None, None, None).unwrap();

        assert_eq!(
            db.settle_worker_report("nope", DISPATCH, "succeeded", "x").unwrap(),
            WorkerReportSettlement::rejected("unknown_task", "Unknown task nope.".to_string())
        );
        assert_eq!(
            db.settle_worker_report(TASK, "ctx_missing", "succeeded", "x").unwrap(),
            WorkerReportSettlement::rejected(
                "unknown_dispatch",
                "Unknown dispatch ctx_missing.".to_string()
            )
        );
        assert_eq!(
            db.settle_worker_report("task-2", DISPATCH, "succeeded", "x").unwrap(),
            WorkerReportSettlement::rejected(
                "task_dispatch_mismatch",
                "Dispatch ctx_1 belongs to task task-1, not task-2.".to_string()
            )
        );

        // Stale: a newer dispatch owns the task.
        db.connection()
            .execute(
                "INSERT INTO dispatch_contexts (id, task_id, status) VALUES ('ctx_2', ?1, 'dispatched')",
                params![TASK],
            )
            .unwrap();
        assert_eq!(
            db.settle_worker_report(TASK, DISPATCH, "succeeded", "x").unwrap(),
            WorkerReportSettlement::rejected(
                "stale_dispatch",
                "Dispatch ctx_1 is not the current dispatch for task task-1.".to_string()
            )
        );

        // Inactive: the dispatch is settled but its task is not in the matching state.
        db.connection()
            .execute("DELETE FROM dispatch_contexts WHERE id = 'ctx_2'", [])
            .unwrap();
        db.connection()
            .execute("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?1", params![DISPATCH])
            .unwrap();
        assert_eq!(
            db.settle_worker_report(TASK, DISPATCH, "succeeded", "x").unwrap(),
            WorkerReportSettlement::rejected(
                "inactive_dispatch",
                "inactive dispatch ctx_1: it or task task-1 is already settled.".to_string()
            )
        );
        // The rejection settled nothing.
        assert_eq!(task_status(&db, TASK), "dispatched");
        assert_eq!(worker(&db, DISPATCH).state, "ready");
    }

    #[test]
    fn report_success_promotes_the_dependents_it_unblocks() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);
        db.create_task("dep-2", "second dep", None, &[], None, None, None, None).unwrap();
        db.create_task("child", "after both", None, &[TASK, "dep-2"], None, None, None, None).unwrap();
        assert_eq!(task_status(&db, "child"), "pending");

        db.settle_worker_report(TASK, DISPATCH, "succeeded", "done").unwrap();
        // Still one dep outstanding.
        assert_eq!(task_status(&db, "child"), "pending");

        db.connection()
            .execute("UPDATE tasks SET status = 'completed' WHERE id = 'dep-2'", [])
            .unwrap();
        // Re-running promotion for the same completed task now clears the child.
        db.promote_ready_tasks(TASK).unwrap();
        assert_eq!(task_status(&db, "child"), "ready");
    }

    #[test]
    fn abandon_settles_the_dispatch_and_blocks_the_task() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);

        let abandoned = db.abandon_worker_dispatch(DISPATCH).unwrap();
        assert_eq!(abandoned.disposition, WorkerAbandonDisposition::Abandoned);
        assert_eq!(abandoned.worker.state, "abandoned");
        assert_eq!(abandoned.worker.stage, "abandoned");
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.status, "failed");
        assert!(row.completed_at.is_some());
        assert!(row.capability_revoked_at.is_some());
        assert_eq!(task_status(&db, TASK), "blocked");

        let again = db.abandon_worker_dispatch(DISPATCH).unwrap();
        assert_eq!(again.disposition, WorkerAbandonDisposition::AlreadyAbandoned);
        assert_coded(db.abandon_worker_dispatch("ctx_missing").unwrap_err(), "dispatch_not_found");
    }

    #[test]
    fn abandon_is_a_no_op_for_a_superseded_dispatch() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);
        db.connection()
            .execute(
                "INSERT INTO dispatch_contexts (id, task_id, status) VALUES ('ctx_2', ?1, 'dispatched')",
                params![TASK],
            )
            .unwrap();

        let stale = db.abandon_worker_dispatch(DISPATCH).unwrap();
        assert_eq!(stale.disposition, WorkerAbandonDisposition::Stale);
        // Nothing moved: the newer dispatch still owns the task.
        assert_eq!(worker(&db, DISPATCH).state, "ready");
        assert_eq!(dispatch(&db, DISPATCH).status, "dispatched");
        assert_eq!(task_status(&db, TASK), "dispatched");
    }

    #[test]
    fn abandon_refuses_a_succeeded_worker() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);
        db.settle_worker_report(TASK, DISPATCH, "succeeded", "done").unwrap();

        let refused = db.abandon_worker_dispatch(DISPATCH).unwrap_err();
        assert_eq!(
            assert_coded(refused, "dispatch_inactive")["message"],
            "Dispatch ctx_1 already succeeded and cannot be abandoned."
        );
        // The refusal rolled back: the completion stands.
        assert_eq!(worker(&db, DISPATCH).state, "succeeded");
        assert_eq!(task_status(&db, TASK), "completed");
    }

    #[test]
    fn record_stage_updates_only_the_fields_it_is_given() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);

        db.record_worker_stage(&WorkerStageUpdate {
            dispatch_id: DISPATCH.to_string(),
            stage: "worktree_ready".to_string(),
            worktree_id: Some("wt-1".to_string()),
            terminal_handle: Some("term-1".to_string()),
            setup_state: Some("running".to_string()),
            effects: Some(vec![json!({"action":"created_worktree"})]),
            residual_resources: Some(vec![json!({"action":"created_worktree"})]),
            last_error: Some("transient".to_string()),
            state: None,
        })
        .unwrap();

        // A later stage-only update keeps every other column.
        let kept = db
            .record_worker_stage(&WorkerStageUpdate {
                dispatch_id: DISPATCH.to_string(),
                stage: "terminal_ready".to_string(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(kept.stage, "terminal_ready");
        assert_eq!(kept.state, "starting");
        assert_eq!(kept.worktree_id.as_deref(), Some("wt-1"));
        assert_eq!(kept.agent_terminal_handle.as_deref(), Some("term-1"));
        assert_eq!(kept.setup_state, "running");
        assert_eq!(kept.effects, r#"[{"action":"created_worktree"}]"#);
        assert_eq!(kept.last_error.as_deref(), Some("transient"));

        // An explicitly empty effects array overwrites — `[]` is not "absent".
        let cleared = db
            .record_worker_stage(&WorkerStageUpdate {
                dispatch_id: DISPATCH.to_string(),
                stage: "terminal_ready".to_string(),
                effects: Some(Vec::new()),
                state: Some("start_unknown".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(cleared.effects, "[]");
        assert_eq!(cleared.state, "start_unknown");

        assert_coded(
            db.record_worker_stage(&WorkerStageUpdate {
                dispatch_id: "ctx_missing".to_string(),
                stage: "x".to_string(),
                ..Default::default()
            })
            .unwrap_err(),
            "dispatch_not_found",
        );
    }

    #[test]
    fn setup_evidence_reports_an_identical_write_as_unchanged() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);
        let effects = [json!({"action":"created_worktree"})];

        let first = db.update_worker_setup_evidence(DISPATCH, "running", &effects).unwrap();
        assert!(first.changed);
        assert_eq!(first.worker.setup_state, "running");
        assert_eq!(first.worker.effects, r#"[{"action":"created_worktree"}]"#);

        let repeat = db.update_worker_setup_evidence(DISPATCH, "running", &effects).unwrap();
        assert!(!repeat.changed);
        assert_eq!(repeat.worker.updated_at, first.worker.updated_at);

        let moved = db.update_worker_setup_evidence(DISPATCH, "ready", &effects).unwrap();
        assert!(moved.changed);
        assert_eq!(moved.worker.setup_state, "ready");

        assert_coded(
            db.update_worker_setup_evidence("ctx_missing", "ready", &effects).unwrap_err(),
            "dispatch_not_found",
        );
    }

    #[test]
    fn authority_binds_the_process_and_keeps_only_created_effects_as_residual() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        started(&db);
        let effects = vec![
            json!({"action":"created_worktree","id":"wt-1"}),
            json!({"action":"reused_agent_terminal","id":"term-1"}),
            json!({"action":"inspected_repo"}),
            json!("not-an-object"),
        ];

        let capability = db
            .prepare_starting_worker_authority(&PrepareWorkerAuthorityParams {
                dispatch_id: DISPATCH.to_string(),
                handle: "term-1".to_string(),
                pane_key: "win:1:pane:2".to_string(),
                process_incarnation: "pid-1".to_string(),
                launch_token_hash: Some("lt-hash".to_string()),
                worktree_id: "wt-1".to_string(),
                effects: effects.clone(),
                setup_state: "running".to_string(),
            })
            .unwrap();

        assert!(capability.starts_with("dcap_"));
        assert_eq!(capability.len(), "dcap_".len() + 43);
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.assignee_handle.as_deref(), Some("term-1"));
        assert_eq!(row.assignee_pane_key.as_deref(), Some("win:1:pane:2"));
        assert_eq!(row.process_incarnation.as_deref(), Some("pid-1"));
        assert_eq!(row.capability_hash, Some(hash_dispatch_capability(&capability)));
        assert_eq!(row.launch_token_hash.as_deref(), Some("lt-hash"));
        assert_eq!(row.capability_revoked_at, None);
        let bound = worker(&db, DISPATCH);
        assert_eq!(bound.stage, "authority_attached");
        assert_eq!(bound.worktree_id.as_deref(), Some("wt-1"));
        assert_eq!(bound.agent_terminal_handle.as_deref(), Some("term-1"));
        assert_eq!(bound.setup_state, "running");
        assert_eq!(bound.effects, serde_json::to_string(&effects).unwrap());
        assert_eq!(
            bound.residual_resources,
            r#"[{"action":"created_worktree","id":"wt-1"},{"action":"reused_agent_terminal","id":"term-1"}]"#
        );
        // Every capability is fresh.
        assert_ne!(capability, mint_dispatch_capability_token().unwrap());
    }

    #[test]
    fn authority_refuses_a_settled_dispatch_and_a_second_launch_token() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.create_task(TASK, "ship it", None, &[], None, None, None, None).unwrap();
        let mut params = start_params(DISPATCH, TASK);
        params.launch_token_hash = Some("lt-hash".to_string());
        db.create_starting_worker_dispatch(&params).unwrap();

        let authority = PrepareWorkerAuthorityParams {
            dispatch_id: DISPATCH.to_string(),
            handle: "term-1".to_string(),
            pane_key: "win:1:pane:2".to_string(),
            process_incarnation: "pid-1".to_string(),
            launch_token_hash: Some("other-hash".to_string()),
            worktree_id: "wt-1".to_string(),
            effects: Vec::new(),
            setup_state: "running".to_string(),
        };
        let mismatch = db.prepare_starting_worker_authority(&authority).unwrap_err();
        assert_eq!(
            assert_coded(mismatch, "request_mismatch")["message"],
            "Dispatch ctx_1 already has a different launch-token commitment."
        );
        // Nothing was bound.
        assert_eq!(dispatch(&db, DISPATCH).capability_hash, None);

        db.mark_worker_dispatch_ready(DISPATCH, None).unwrap();
        let mut matching = authority.clone();
        matching.launch_token_hash = Some("lt-hash".to_string());
        let inactive = db.prepare_starting_worker_authority(&matching).unwrap_err();
        assert_eq!(
            assert_coded(inactive, "dispatch_inactive")["message"],
            "Dispatch ctx_1 is not starting."
        );
        assert_coded(
            db.prepare_starting_worker_authority(&PrepareWorkerAuthorityParams {
                dispatch_id: "ctx_missing".to_string(),
                ..matching
            })
            .unwrap_err(),
            "dispatch_inactive",
        );
    }

    #[test]
    fn recovery_rows_list_live_workers_in_insertion_order() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);
        db.prepare_starting_worker_authority(&PrepareWorkerAuthorityParams {
            dispatch_id: DISPATCH.to_string(),
            handle: "term-1".to_string(),
            pane_key: "win:1:pane:2".to_string(),
            process_incarnation: "pid-1".to_string(),
            launch_token_hash: None,
            worktree_id: "wt-1".to_string(),
            effects: Vec::new(),
            setup_state: "running".to_string(),
        })
        .unwrap_err();

        db.create_task("task-2", "second", None, &[], None, None, None, None).unwrap();
        db.create_starting_worker_dispatch(&start_params("ctx_2", "task-2")).unwrap();
        db.create_task("task-3", "third", None, &[], None, None, None, None).unwrap();
        db.create_starting_worker_dispatch(&start_params("ctx_3", "task-3")).unwrap();
        // A settled worker drops out of the sweep.
        db.fail_worker_start("ctx_3", "terminal", "gone").unwrap();

        let rows = db.list_legacy_worker_terminal_recovery_rows().unwrap();
        assert_eq!(
            rows.iter().map(|row| row.dispatch_id.as_str()).collect::<Vec<_>>(),
            vec![DISPATCH, "ctx_2"]
        );
        assert_eq!(rows[0].task_id, TASK);
        assert_eq!(rows[0].dispatch_status, "dispatched");
        assert_eq!(rows[0].worker_state, "ready");
        assert_eq!(rows[0].contract_version, CURRENT_CONTRACT_VERSION);
        assert_eq!(rows[1].worker_state, "starting");
    }

    #[test]
    fn missing_terminal_abandons_a_live_worker_and_frees_its_task() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);

        let settled = db.reconcile_missing_worker_terminal(DISPATCH, "terminal gone").unwrap();
        assert_eq!(settled.state, "abandoned");
        assert_eq!(settled.stage, "terminal_missing");
        assert_eq!(settled.last_error.as_deref(), Some("terminal gone"));
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.status, "failed");
        assert_eq!(row.failure_count, 1);
        assert!(row.capability_revoked_at.is_some());
        // Retryable, so the task goes back to `ready` with no completion stamp.
        let task = db.get_task(TASK).unwrap().unwrap();
        assert_eq!(task.status, "ready");
        assert_eq!(task.completed_at, None);

        // Already settled: returned untouched.
        let again = db.reconcile_missing_worker_terminal(DISPATCH, "second sweep").unwrap();
        assert_eq!(again.last_error.as_deref(), Some("terminal gone"));
        assert_coded(
            db.reconcile_missing_worker_terminal("ctx_missing", "x").unwrap_err(),
            "dispatch_not_found",
        );
    }

    #[test]
    fn missing_terminal_settles_a_pending_stop_as_stopped() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);
        db.begin_worker_stop(DISPATCH).unwrap();

        let settled = db.reconcile_missing_worker_terminal(DISPATCH, "terminal gone").unwrap();
        assert_eq!(settled.state, "stopped");
        assert_eq!(settled.stage, "terminal_missing");
        // The stop already blocked the task; recovery must not hand it back out.
        assert_eq!(task_status(&db, TASK), "blocked");
        assert_eq!(dispatch(&db, DISPATCH).status, "failed");
    }

    #[test]
    fn missing_terminal_trips_the_circuit_breaker_on_the_third_failure() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        ready(&db);
        db.connection()
            .execute("UPDATE dispatch_contexts SET failure_count = 2 WHERE id = ?1", params![DISPATCH])
            .unwrap();

        db.reconcile_missing_worker_terminal(DISPATCH, "terminal gone").unwrap();
        let row = dispatch(&db, DISPATCH);
        assert_eq!(row.status, "circuit_broken");
        assert_eq!(row.failure_count, 3);
        let task = db.get_task(TASK).unwrap().unwrap();
        assert_eq!(task.status, "failed");
        assert!(task.completed_at.is_some());
    }
}
