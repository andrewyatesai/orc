//! Legacy compatibility: the surface a pre-Run agent CLI still speaks. Calls
//! arrive with no Run and no capability, so they are authenticated as a
//! `legacy_compatibility_principals` row and made idempotent by
//! `legacy_operation_receipts` / `legacy_mail_receipts` instead.
//!
//! Ported from the legacy section of `src/main/runtime/orchestration/db.ts`.
//! Tables: `legacy_adoptions`, `legacy_compatibility_principals`,
//! `legacy_operation_receipts`, `legacy_mail_receipts` (+ `messages`,
//! `question_threads`, `dispatch_contexts`, `runs`).
//!
//! Timestamp exposure: as in `questions`, the TS twin's `exposeMessageTimestamps`
//! / `exposeQuestionTimestamps` wrappers are deliberately NOT applied here — the
//! fork's contract is that the Rust store returns rows as SQLite wrote them and
//! the shim owns RFC3339 exposure at the JSON boundary.
//!
//! Generated ids: the three commit paths mint message ids inline in the TS twin
//! (`generateId('msg')`), and their Rust signatures take no id, so the same
//! `<prefix>_<12 hex>` shape is minted from SQLite `randomblob` here rather than
//! by the caller.

use super::error::{orchestration_err, OrchestrationError};
use super::legacy_question_matching::legacy_message_matches_question;
use super::lifecycle_rejection::has_lifecycle_rejection_marker;
use super::pane_key::is_equivalent_pane_key;
use super::runs::promote_legacy_coordinator_mail;
use super::rows::{
    row_to_dispatch, row_to_legacy_adoption, row_to_legacy_mail_receipt,
    row_to_legacy_operation_receipt, row_to_legacy_principal, row_to_message, DispatchContext,
    LegacyAdoption, LegacyCompatibilityPrincipal, LegacyMailReceipt, LegacyOperationReceipt,
    Message, NewRunMessage, Question, DISPATCH_COLUMNS, LEGACY_ADOPTION_COLUMNS,
    LEGACY_MAIL_RECEIPT_COLUMNS, LEGACY_OPERATION_RECEIPT_COLUMNS, LEGACY_PRINCIPAL_COLUMNS,
    LEGACY_ROLE_COORDINATOR, LEGACY_ROLE_WORKER, MESSAGE_COLUMNS,
};
use super::run_contract::{
    DELIVERY_CONTRACT_CURRENT, DELIVERY_CONTRACT_LEGACY_DIRECT, LEGACY_CONTRACT_VERSION,
    LEGACY_RUN_ID,
};
use super::sql_fragments::{placeholders, type_filter_clause};
use super::worker_dispatch::WorkerReportSettlement;
use super::OrchestrationDb;
use orca_store::{Database, StoreError};
use rusqlite::{params, params_from_iter, OptionalExtension, ToSql};

/// TS `commitLegacyCompatibilityPrincipal(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitLegacyPrincipalParams {
    /// Caller-generated principal id.
    pub id: String,
    pub run_id: String,
    /// Required for `worker`, must be absent for `coordinator` (table CHECK).
    pub dispatch_id: Option<String>,
    /// [`super::rows::LEGACY_ROLE_WORKER`] or `LEGACY_ROLE_COORDINATOR`.
    pub role: String,
    pub host_scope: String,
    pub terminal_handle: String,
    pub pane_key: String,
    pub launch_token_hash: String,
    pub process_incarnation: Option<String>,
}

/// TS `{ principal; duplicate }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct CommittedLegacyPrincipal {
    pub principal: LegacyCompatibilityPrincipal,
    pub duplicate: bool,
}

/// TS `resolveLegacyCompatibilityPrincipalByIdentity(params)` /
/// `resolveLegacyWorkerCandidate(params)` — an identity presented piecemeal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyIdentityQuery {
    pub run_id: Option<String>,
    pub role: Option<String>,
    pub terminal_handle: Option<String>,
    pub pane_key: Option<String>,
    pub dispatch_id: Option<String>,
    pub task_id: Option<String>,
}

/// TS `resolveLegacyCoordinatorCandidate` result. Why camelCase: this is a
/// composed result object (`{ terminalHandle, paneKey }`, db.ts:1691), not a
/// table row, so the TS keys are camelCase.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCoordinatorCandidate {
    pub terminal_handle: String,
    pub pane_key: String,
}

/// TS `getLegacyMailPage` / `getLegacyMailHistory` result. `recovery` marks a
/// page served from the recovery cohort rather than the live mailbox.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LegacyMailPage {
    pub messages: Vec<Message>,
    pub recovery: bool,
}

/// TS `acknowledgeLegacyMail` result.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LegacyMailAck {
    pub receipts: Vec<LegacyMailReceipt>,
    pub duplicate: bool,
}

/// TS `commitLegacyLifecycleOperation(params.message)`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyOperationMessage {
    /// Present on a retry that already minted an id.
    pub existing_id: Option<String>,
    pub to: String,
    pub subject: String,
    pub body: String,
    pub message_type: String,
    pub priority: String,
    pub payload: Option<String>,
}

/// TS `commitLegacyLifecycleOperation(params.lifecycle)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyLifecycle {
    MessageOnly,
    Heartbeat { at: String },
    WorkerReport { task_id: String, outcome: String, result: String },
}

/// The `(principal, operation_key, method, payload_hash)` tuple every legacy
/// commit is keyed by — the legacy analogue of a mutation receipt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyOperationKey {
    pub principal_id: String,
    pub operation_key: String,
    pub method: String,
    pub payload_hash: String,
}

/// TS `commitLegacyLifecycleOperation` result.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LegacyLifecycleCommit {
    pub receipt: LegacyOperationReceipt,
    pub message: Message,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement: Option<WorkerReportSettlement>,
    pub duplicate: bool,
}

/// TS `commitLegacyAskOperation` / `commitLegacyReplyOperation` result.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LegacyQuestionCommit {
    pub receipt: LegacyOperationReceipt,
    pub question: Question,
    pub message: Message,
    pub duplicate: bool,
}

/// TS `acknowledgeLegacyQuestionAnswer` result.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LegacyAnswerAck {
    pub receipt: LegacyMailReceipt,
    pub duplicate: bool,
}

/// TS `findLegacyWorkerCompletion(params)`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyWorkerCompletionQuery {
    pub principal_id: String,
    pub task_id: String,
    pub recipient_handle: String,
    pub subject: String,
    pub body: String,
    pub payload: Option<String>,
}

/// Where a legacy worker's mail must be addressed right now: the retained
/// coordinator handle over `legacy_direct`, or the Run mailbox over
/// `current_delivery` once a current consumer has taken the seat.
struct LegacyDelivery {
    to: String,
    contract: String,
}

/// The `messages.payload` an `ask` writes. Declaration order is the TS
/// object-literal order, so `serde_json::to_string` is byte-identical to
/// `JSON.stringify({ taskId, dispatchId, question, options })`.
#[derive(serde::Serialize)]
struct LegacyAskPayload<'a> {
    #[serde(rename = "taskId")]
    task_id: &'a str,
    #[serde(rename = "dispatchId")]
    dispatch_id: &'a str,
    question: &'a str,
    options: &'a [String],
}

/// `legacy_operation_receipts.response_json` for a lifecycle commit.
#[derive(serde::Serialize)]
struct LifecycleResponse<'a> {
    #[serde(rename = "messageId")]
    message_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    settlement: Option<&'a WorkerReportSettlement>,
}

/// `legacy_operation_receipts.response_json` for an ask commit.
#[derive(serde::Serialize)]
struct AskResponse<'a> {
    #[serde(rename = "questionId")]
    question_id: &'a str,
}

/// `legacy_operation_receipts.response_json` for a reply commit.
#[derive(serde::Serialize)]
struct ReplyResponse<'a> {
    #[serde(rename = "questionId")]
    question_id: &'a str,
    #[serde(rename = "messageId")]
    message_id: &'a str,
}

impl OrchestrationDb {
    /// TS `acknowledgeLegacyMail`.
    pub fn acknowledge_legacy_mail(
        &self,
        principal_id: &str,
        message_ids: &[&str],
        types: Option<&[String]>,
    ) -> Result<LegacyMailAck, StoreError> {
        if message_ids.is_empty() {
            return Ok(LegacyMailAck { receipts: Vec::new(), duplicate: true });
        }
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.acknowledge_legacy_mail_in_transaction(principal_id, message_ids, types) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn acknowledge_legacy_mail_in_transaction(
        &self,
        principal_id: &str,
        message_ids: &[&str],
        types: Option<&[String]>,
    ) -> Result<LegacyMailAck, StoreError> {
        let principal = self.legacy_mail_principal(principal_id, None)?;
        // `[...new Set(ids)]` — dedupe, first-seen order preserved.
        let mut unique_ids: Vec<&str> = Vec::with_capacity(message_ids.len());
        for id in message_ids {
            if !unique_ids.contains(id) {
                unique_ids.push(id);
            }
        }
        let list = placeholders(unique_ids.len());
        let conn = self.db.connection();

        let mut binds: Vec<&dyn ToSql> = vec![&principal_id];
        for id in &unique_ids {
            binds.push(id as &dyn ToSql);
        }
        let prior_count: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM legacy_mail_receipts
                 WHERE principal_id = ? AND message_id IN ({list})
                   AND acknowledged_at IS NOT NULL"
            ),
            params_from_iter(binds),
            |row| row.get(0),
        )?;
        if prior_count != unique_ids.len() as i64 {
            let actionable = self
                .get_legacy_mail_page(principal_id, Some(unique_ids.len() as i64), types)?
                .messages;
            if actionable.len() != unique_ids.len()
                || actionable.iter().zip(&unique_ids).any(|(message, id)| message.id != *id)
            {
                return orchestration_err(
                    "request_mismatch",
                    "Legacy mail acknowledgment does not match the current replay page.",
                );
            }
        }

        let mut binds: Vec<&dyn ToSql> = Vec::with_capacity(unique_ids.len() + 1);
        for id in &unique_ids {
            binds.push(id as &dyn ToSql);
        }
        binds.push(&principal.run_id);
        let rows: Vec<Message> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {MESSAGE_COLUMNS} FROM messages
                 WHERE id IN ({list}) AND run_id = ?
                   AND delivery_contract = 'legacy_direct'"
            ))?;
            let rows = stmt.query_map(params_from_iter(binds), row_to_message)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let dispatch_address = principal
            .dispatch_id
            .as_deref()
            .map(|dispatch_id| format!("dispatch:{dispatch_id}"));
        // A `Set` in the TS, so two rows sharing an id count once.
        let mut valid_ids: Vec<&str> = Vec::new();
        for message in &rows {
            let addressed = message.to_handle == principal.terminal_handle
                || (principal.role == LEGACY_ROLE_WORKER
                    && Some(message.to_handle.as_str()) == dispatch_address.as_deref());
            if addressed && !valid_ids.contains(&message.id.as_str()) {
                valid_ids.push(message.id.as_str());
            }
        }
        if valid_ids.len() != unique_ids.len()
            || unique_ids.iter().any(|id| !valid_ids.contains(id))
        {
            return orchestration_err(
                "request_mismatch",
                "Legacy mail acknowledgment contains a message outside this principal inbox.",
            );
        }

        let binds: Vec<&dyn ToSql> = unique_ids.iter().map(|id| id as &dyn ToSql).collect();
        conn.execute(
            &format!(
                "UPDATE messages
                 SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
                 WHERE id IN ({list})"
            ),
            params_from_iter(binds),
        )?;
        for message_id in &unique_ids {
            self.legacy_record_mail_receipt(principal_id, message_id)?;
        }

        let mut binds: Vec<&dyn ToSql> = vec![&principal_id];
        for id in &unique_ids {
            binds.push(id as &dyn ToSql);
        }
        let receipts = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {LEGACY_MAIL_RECEIPT_COLUMNS} FROM legacy_mail_receipts
                 WHERE principal_id = ? AND message_id IN ({list})
                 ORDER BY message_id"
            ))?;
            let rows = stmt.query_map(params_from_iter(binds), row_to_legacy_mail_receipt)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(LegacyMailAck { receipts, duplicate: prior_count == unique_ids.len() as i64 })
    }

    /// TS `acknowledgeLegacyQuestionAnswer`.
    pub fn acknowledge_legacy_question_answer(
        &self,
        principal_id: &str,
        question_id: &str,
        answer_message_id: &str,
    ) -> Result<LegacyAnswerAck, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.acknowledge_legacy_answer_in_transaction(
            principal_id,
            question_id,
            answer_message_id,
        ) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn acknowledge_legacy_answer_in_transaction(
        &self,
        principal_id: &str,
        question_id: &str,
        answer_message_id: &str,
    ) -> Result<LegacyAnswerAck, StoreError> {
        let principal = self.legacy_mail_principal(principal_id, Some(LEGACY_ROLE_WORKER))?;
        let question = self.get_question(question_id)?;
        let source = self.get_message_by_id(question_id)?;
        let answer = self.get_message_by_id(answer_message_id)?;
        let dispatch = match principal.dispatch_id.as_deref() {
            Some(dispatch_id) => self.dispatch_context_by_id(dispatch_id)?,
            None => None,
        };
        let dispatch_address =
            format!("dispatch:{}", principal.dispatch_id.as_deref().unwrap_or_default());
        let run_address = format!("run:{}", principal.run_id);

        let exact_legacy_answer = answer.as_ref().is_some_and(|answer| {
            answer.delivery_contract.as_deref() == Some(DELIVERY_CONTRACT_LEGACY_DIRECT)
                && (answer.to_handle == principal.terminal_handle
                    || answer.to_handle == dispatch_address)
        });
        let adoption = self.get_legacy_adoption()?;
        let exact_taken_over_answer = adoption
            .as_ref()
            .is_some_and(|adoption| adoption.adopted_run_id == principal.run_id)
            && dispatch.as_ref().is_some_and(|dispatch| {
                dispatch.run_id == principal.run_id
                    && dispatch.contract_version == LEGACY_CONTRACT_VERSION
            })
            && source.as_ref().is_some_and(|source| {
                source.run_id == principal.run_id
                    && source.from_handle == principal.terminal_handle
                    && source.to_handle == run_address
                    && source.delivery_contract.as_deref() == Some(DELIVERY_CONTRACT_CURRENT)
            })
            && answer.as_ref().is_some_and(|answer| {
                answer.run_id == principal.run_id
                    && answer.delivery_contract.as_deref() == Some(DELIVERY_CONTRACT_CURRENT)
                    && answer.from_handle == run_address
                    && answer.to_handle == dispatch_address
                    && answer.thread_id.as_deref()
                        == question.as_ref().map(|question| question.message_id.as_str())
            });

        let matches_principal = question.as_ref().is_some_and(|question| {
            question.run_id == principal.run_id
                && Some(question.dispatch_id.as_str()) == principal.dispatch_id.as_deref()
                && question.answer_message_id.as_deref() == Some(answer_message_id)
        });
        if !matches_principal
            || answer.is_none()
            || (!exact_legacy_answer && !exact_taken_over_answer)
        {
            return orchestration_err(
                "request_mismatch",
                "Legacy answer acknowledgment does not match this principal question.",
            );
        }

        let existing = self.legacy_mail_receipt(principal_id, answer_message_id)?;
        self.db.connection().execute(
            "UPDATE messages
             SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
             WHERE id = ?1",
            params![answer_message_id],
        )?;
        self.legacy_record_mail_receipt(principal_id, answer_message_id)?;
        let receipt = self.legacy_mail_receipt(principal_id, answer_message_id)?.ok_or_else(|| {
            StoreError::Message("legacy mail receipt vanished after insert".into())
        })?;
        let duplicate = existing.is_some_and(|receipt| receipt.acknowledged_at.is_some());
        Ok(LegacyAnswerAck { receipt, duplicate })
    }

    /// TS `commitLegacyAskOperation` — a worker principal opening a question.
    pub fn commit_legacy_ask_operation(
        &self,
        key: &LegacyOperationKey,
        question: &str,
        options: &[String],
        recipient_handle: &str,
        existing_question_id: Option<&str>,
    ) -> Result<LegacyQuestionCommit, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.commit_legacy_ask_in_transaction(
            key,
            question,
            options,
            recipient_handle,
            existing_question_id,
        ) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn commit_legacy_ask_in_transaction(
        &self,
        key: &LegacyOperationKey,
        question_text: &str,
        options: &[String],
        recipient_handle: &str,
        existing_question_id: Option<&str>,
    ) -> Result<LegacyQuestionCommit, StoreError> {
        let principal =
            self.legacy_committed_principal(&key.principal_id, Some(LEGACY_ROLE_WORKER))?;
        if let Some(receipt) = self.legacy_matching_operation_receipt(key)? {
            let response: serde_json::Value = serde_json::from_str(&receipt.response_json)
                .map_err(|error| StoreError::Message(error.to_string()))?;
            let question_id = response["questionId"].as_str().unwrap_or_default().to_string();
            let question = self.get_question(&question_id)?;
            let message = self.get_message_by_id(&question_id)?;
            let (Some(question), Some(message)) = (question, message) else {
                return orchestration_err(
                    "operation_unknown",
                    format!("Legacy ask {} lost its durable question.", key.operation_key),
                );
            };
            return Ok(LegacyQuestionCommit { receipt, question, message, duplicate: true });
        }

        let dispatch_id = principal.dispatch_id.clone().unwrap_or_default();
        let dispatch = self.dispatch_context_by_id(&dispatch_id)?;
        let Some(dispatch) = dispatch.filter(|dispatch| {
            dispatch.run_id == principal.run_id
                && dispatch.contract_version == LEGACY_CONTRACT_VERSION
                && (dispatch.status == "pending" || dispatch.status == "dispatched")
        }) else {
            return orchestration_err(
                "dispatch_inactive",
                format!("Dispatch {dispatch_id} is not an active legacy attempt."),
            );
        };

        // Why: a question already claimed by an `orchestration.ask` receipt belongs
        // to that operation, so a different operation key must mint a fresh one.
        let claimable_question_id = match existing_question_id.filter(|id| !id.is_empty()) {
            Some(id) => {
                let claimed: Option<i64> = self
                    .db
                    .connection()
                    .query_row(
                        "SELECT 1 FROM legacy_operation_receipts
                         WHERE principal_id = ?1 AND method = 'orchestration.ask' AND effect_id = ?2
                         LIMIT 1",
                        params![principal.id, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if claimed.is_some() {
                    None
                } else {
                    Some(id)
                }
            }
            None => None,
        };
        let delivery = self.legacy_worker_coordinator_delivery(&principal.run_id, recipient_handle)?;

        let (question, message) = match claimable_question_id {
            Some(id) => {
                let existing_question = self.get_question(id)?;
                let existing_message = self.get_message_by_id(id)?;
                let usable = match (&existing_question, &existing_message) {
                    (Some(question), Some(message)) => {
                        question.run_id == principal.run_id
                            && question.dispatch_id == dispatch_id
                            && question.status == "pending"
                            && message.delivery_contract.as_deref() == Some(delivery.contract.as_str())
                            && legacy_message_matches_question(
                                message,
                                question_text,
                                options,
                                &[delivery.to.as_str()],
                            )
                    }
                    _ => false,
                };
                if !usable {
                    return orchestration_err(
                        "request_mismatch",
                        format!(
                            "Question {} is not a pending ask for this principal.",
                            existing_question_id.unwrap_or_default()
                        ),
                    );
                }
                // `usable` already proved both are present.
                (
                    existing_question.expect("usable ask has a thread"),
                    existing_message.expect("usable ask has a message"),
                )
            }
            None => {
                let payload = serde_json::to_string(&LegacyAskPayload {
                    task_id: &dispatch.task_id,
                    dispatch_id: &dispatch_id,
                    question: question_text,
                    options,
                })
                .map_err(|error| StoreError::Message(error.to_string()))?;
                let message_type = if delivery.contract == DELIVERY_CONTRACT_LEGACY_DIRECT {
                    "decision_gate"
                } else {
                    "question"
                };
                let message = self.insert_run_message(&NewRunMessage {
                    id: self.legacy_generate_id("msg")?,
                    run_id: principal.run_id.clone(),
                    delivery_contract: delivery.contract.clone(),
                    from_handle: principal.terminal_handle.clone(),
                    to_handle: delivery.to.clone(),
                    subject: "Question".to_string(),
                    body: question_text.to_string(),
                    message_type: message_type.to_string(),
                    payload: Some(payload),
                    sender_pane_key: Some(principal.pane_key.clone()),
                    ..NewRunMessage::default()
                })?;
                // Why: a question message is the head of its own thread, so the
                // thread id can only be stamped once the row exists.
                self.db.connection().execute(
                    "UPDATE messages SET thread_id = ?1 WHERE id = ?2",
                    params![message.id, message.id],
                )?;
                self.db.connection().execute(
                    "INSERT INTO question_threads (
                       message_id, run_id, dispatch_id, asker_handle
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        message.id,
                        principal.run_id,
                        dispatch_id,
                        principal.terminal_handle
                    ],
                )?;
                let question = self.get_question(&message.id)?.ok_or_else(|| {
                    StoreError::Message("question thread vanished after insert".into())
                })?;
                let stored = self.get_message_by_id(&message.id)?.ok_or_else(|| {
                    StoreError::Message("question message vanished after insert".into())
                })?;
                (question, stored)
            }
        };

        let response = serde_json::to_string(&AskResponse { question_id: &question.message_id })
            .map_err(|error| StoreError::Message(error.to_string()))?;
        let receipt =
            self.legacy_insert_operation_receipt(key, &question.message_id, &response)?;
        Ok(LegacyQuestionCommit { receipt, question, message, duplicate: false })
    }

    /// TS `commitLegacyCompatibilityPrincipal` — the login step; every other
    /// legacy call presents the principal id it returns.
    pub fn commit_legacy_compatibility_principal(
        &self,
        params: &CommitLegacyPrincipalParams,
    ) -> Result<CommittedLegacyPrincipal, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.commit_legacy_principal_in_transaction(params) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn commit_legacy_principal_in_transaction(
        &self,
        params: &CommitLegacyPrincipalParams,
    ) -> Result<CommittedLegacyPrincipal, StoreError> {
        let adoption = self.get_legacy_adoption()?;
        if adoption.as_ref().map(|adoption| adoption.adopted_run_id.as_str())
            != Some(params.run_id.as_str())
        {
            return orchestration_err(
                "request_mismatch",
                format!("Run {} is not the adopted legacy Run.", params.run_id),
            );
        }
        let is_worker = params.role == LEGACY_ROLE_WORKER;
        let dispatch_id = if is_worker { params.dispatch_id.clone() } else { None };
        let mut initial_status = "committed";
        if is_worker {
            let dispatch = match dispatch_id.as_deref() {
                Some(id) => self.dispatch_context_by_id(id)?,
                None => None,
            };
            let Some(dispatch) = dispatch.filter(|dispatch| {
                dispatch.run_id == params.run_id
                    && dispatch.contract_version == LEGACY_CONTRACT_VERSION
            }) else {
                return orchestration_err(
                    "request_mismatch",
                    format!(
                        "Dispatch {} is not a legacy attempt in this Run.",
                        dispatch_id.as_deref().unwrap_or("(missing)")
                    ),
                );
            };
            initial_status = if dispatch.status == "pending" || dispatch.status == "dispatched" {
                "committed"
            } else {
                "settled"
            };
        } else if params.dispatch_id.as_deref().is_some_and(|id| !id.is_empty()) {
            return orchestration_err(
                "request_mismatch",
                "A coordinator compatibility principal cannot name a Dispatch.",
            );
        }

        let existing = {
            let conn = self.db.connection();
            let mut stmt = conn.prepare(&format!(
                "SELECT {LEGACY_PRINCIPAL_COLUMNS} FROM legacy_compatibility_principals
                 WHERE role = ?1 AND run_id = ?2 AND dispatch_id IS ?3"
            ))?;
            stmt.query_row(
                params![params.role, params.run_id, dispatch_id],
                row_to_legacy_principal,
            )
            .optional()?
        };
        if let Some(existing) = existing {
            let same = existing.host_scope == params.host_scope
                && existing.terminal_handle == params.terminal_handle
                && existing.pane_key == params.pane_key
                && existing.launch_token_hash == params.launch_token_hash
                && existing.process_incarnation == params.process_incarnation;
            if !same {
                return orchestration_err(
                    "request_mismatch",
                    format!(
                        "The {} compatibility principal is already committed to different proof.",
                        params.role
                    ),
                );
            }
            if existing.status == "revoked" {
                return Err(OrchestrationError::with_data(
                    "legacy_read_only",
                    format!(
                        "The {} compatibility principal has been revoked. No effects were applied.",
                        params.role
                    ),
                    serde_json::json!({ "effectsApplied": false }),
                )
                .into());
            }
            return Ok(CommittedLegacyPrincipal { principal: existing, duplicate: true });
        }

        if !is_worker
            && self
                .resolve_legacy_coordinator_candidate(&LegacyIdentityQuery {
                    run_id: Some(params.run_id.clone()),
                    terminal_handle: Some(params.terminal_handle.clone()),
                    pane_key: Some(params.pane_key.clone()),
                    ..LegacyIdentityQuery::default()
                })?
                .is_none()
        {
            return Err(OrchestrationError::with_data(
                "legacy_read_only",
                "This retained legacy coordinator no longer has lifecycle authority. No effects were applied.",
                serde_json::json!({ "effectsApplied": false }),
            )
            .into());
        }

        self.db.connection().execute(
            "INSERT INTO legacy_compatibility_principals (
               id, run_id, dispatch_id, role, host_scope, terminal_handle,
               pane_key, launch_token_hash, process_incarnation, status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                params.id,
                params.run_id,
                dispatch_id,
                params.role,
                params.host_scope,
                params.terminal_handle,
                params.pane_key,
                params.launch_token_hash,
                params.process_incarnation,
                initial_status,
            ],
        )?;
        let principal = self
            .get_legacy_compatibility_principal(&params.id)?
            .ok_or_else(|| StoreError::Message("legacy principal vanished after insert".into()))?;
        if principal.status == "committed" {
            self.legacy_initialize_recovery_cohort(&principal)?;
        }
        Ok(CommittedLegacyPrincipal { principal, duplicate: false })
    }

    /// TS `commitLegacyLifecycleOperation` — send/heartbeat/worker-report in one
    /// idempotent commit.
    pub fn commit_legacy_lifecycle_operation(
        &self,
        key: &LegacyOperationKey,
        message: &LegacyOperationMessage,
        lifecycle: &LegacyLifecycle,
    ) -> Result<LegacyLifecycleCommit, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.commit_legacy_lifecycle_in_transaction(key, message, lifecycle) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn commit_legacy_lifecycle_in_transaction(
        &self,
        key: &LegacyOperationKey,
        params: &LegacyOperationMessage,
        lifecycle: &LegacyLifecycle,
    ) -> Result<LegacyLifecycleCommit, StoreError> {
        let principal = self.get_legacy_compatibility_principal(&key.principal_id)?;
        let Some(principal) = principal.filter(|principal| {
            principal.role == LEGACY_ROLE_WORKER
                && (principal.status == "committed" || principal.status == "settled")
        }) else {
            return orchestration_err(
                "request_mismatch",
                format!(
                    "Legacy compatibility principal {} cannot send lifecycle work.",
                    key.principal_id
                ),
            );
        };
        let dispatch_id = principal.dispatch_id.clone().unwrap_or_default();

        if let Some(receipt) = self.legacy_matching_operation_receipt(key)? {
            let response: serde_json::Value = serde_json::from_str(&receipt.response_json)
                .map_err(|error| StoreError::Message(error.to_string()))?;
            let message_id = response["messageId"].as_str().unwrap_or_default();
            let Some(message) = self.get_message_by_id(message_id)? else {
                return orchestration_err(
                    "operation_unknown",
                    format!("Legacy operation {} lost its recorded message.", key.operation_key),
                );
            };
            let settlement = settlement_from_json(response.get("settlement"));
            return Ok(LegacyLifecycleCommit { receipt, message, settlement, duplicate: true });
        }

        let dispatch = self.dispatch_context_by_id(&dispatch_id)?;
        let Some(dispatch) = dispatch.filter(|dispatch| {
            dispatch.run_id == principal.run_id
                && dispatch.contract_version == LEGACY_CONTRACT_VERSION
        }) else {
            return orchestration_err(
                "dispatch_inactive",
                format!("Dispatch {dispatch_id} is not this principal's legacy attempt."),
            );
        };
        let existing_id = params.existing_id.as_deref().filter(|id| !id.is_empty());
        let is_worker_report = matches!(lifecycle, LegacyLifecycle::WorkerReport { .. });
        let dispatch_active = dispatch.status == "pending" || dispatch.status == "dispatched";
        if (principal.status == "settled" || !dispatch_active)
            && (existing_id.is_none() || !is_worker_report)
        {
            return orchestration_err(
                "dispatch_inactive",
                format!(
                    "Dispatch {dispatch_id} is settled and only matching completion reconstruction is allowed."
                ),
            );
        }

        let delivery = self.legacy_worker_coordinator_delivery(&principal.run_id, &params.to)?;
        let message = match existing_id {
            Some(existing_id) => {
                let existing = self.get_message_by_id(existing_id)?;
                let matches_route = existing.as_ref().is_some_and(|message| {
                    let original_legacy = message.delivery_contract.as_deref()
                        == Some(DELIVERY_CONTRACT_LEGACY_DIRECT)
                        && message.to_handle == params.to;
                    let current = message.delivery_contract.as_deref()
                        == Some(delivery.contract.as_str())
                        && message.to_handle == delivery.to;
                    original_legacy || current
                });
                let Some(message) = existing.filter(|message| {
                    message.run_id == principal.run_id
                        && message.from_handle == principal.terminal_handle
                        && matches_route
                }) else {
                    return orchestration_err(
                        "request_mismatch",
                        format!(
                            "Existing legacy message {existing_id} does not match this principal."
                        ),
                    );
                };
                message
            }
            None => self.insert_run_message(&NewRunMessage {
                id: self.legacy_generate_id("msg")?,
                run_id: principal.run_id.clone(),
                delivery_contract: delivery.contract.clone(),
                from_handle: principal.terminal_handle.clone(),
                to_handle: delivery.to.clone(),
                subject: params.subject.clone(),
                body: params.body.clone(),
                // Why: the Rust struct cannot express TS `undefined`, so an empty
                // string is the absent value the TS `?? 'status'` / `?? 'normal'`
                // defaults apply to.
                message_type: default_if_empty(&params.message_type, "status"),
                priority: default_if_empty(&params.priority, "normal"),
                payload: params.payload.clone(),
                sender_pane_key: Some(principal.pane_key.clone()),
                ..NewRunMessage::default()
            })?,
        };

        let mut settlement: Option<WorkerReportSettlement> = None;
        match lifecycle {
            LegacyLifecycle::MessageOnly => {}
            LegacyLifecycle::Heartbeat { at } => {
                self.record_heartbeat(&dispatch_id, at)?;
            }
            LegacyLifecycle::WorkerReport { task_id, outcome, result } => {
                // Why: a completion replayed against an already-settled dispatch is
                // reported from the persisted status rather than re-settled.
                let persisted_outcome = match existing_id {
                    Some(_) if dispatch.task_id == *task_id && dispatch.status == "completed" => {
                        Some("succeeded")
                    }
                    Some(_) if dispatch.task_id == *task_id && dispatch.status == "failed" => {
                        Some("failed")
                    }
                    _ => None,
                };
                let resolved = match persisted_outcome {
                    Some(outcome) => WorkerReportSettlement::Settled {
                        outcome: outcome.to_string(),
                        duplicate: true,
                    },
                    None => self.settle_worker_report_in_transaction(
                        task_id,
                        &dispatch_id,
                        outcome,
                        result,
                    )?,
                };
                if let WorkerReportSettlement::Rejected { code, reason } = &resolved {
                    return Err(OrchestrationError::new(code.clone(), reason.clone()).into());
                }
                self.db.connection().execute(
                    "UPDATE legacy_compatibility_principals
                     SET status = 'settled' WHERE id = ?1 AND status = 'committed'",
                    params![principal.id],
                )?;
                settlement = Some(resolved);
            }
        }

        let response = serde_json::to_string(&LifecycleResponse {
            message_id: &message.id,
            settlement: settlement.as_ref(),
        })
        .map_err(|error| StoreError::Message(error.to_string()))?;
        let receipt = self.legacy_insert_operation_receipt(key, &message.id, &response)?;
        Ok(LegacyLifecycleCommit { receipt, message, settlement, duplicate: false })
    }

    /// TS `commitLegacyReplyOperation` — a coordinator principal answering a
    /// legacy question.
    pub fn commit_legacy_reply_operation(
        &self,
        key: &LegacyOperationKey,
        question_id: &str,
        body: &str,
    ) -> Result<LegacyQuestionCommit, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.commit_legacy_reply_in_transaction(key, question_id, body) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn commit_legacy_reply_in_transaction(
        &self,
        key: &LegacyOperationKey,
        question_id: &str,
        body: &str,
    ) -> Result<LegacyQuestionCommit, StoreError> {
        let principal =
            self.legacy_committed_principal(&key.principal_id, Some(LEGACY_ROLE_COORDINATOR))?;
        if let Some(receipt) = self.legacy_matching_operation_receipt(key)? {
            let response: serde_json::Value = serde_json::from_str(&receipt.response_json)
                .map_err(|error| StoreError::Message(error.to_string()))?;
            let question = self.get_question(response["questionId"].as_str().unwrap_or_default())?;
            let message =
                self.get_message_by_id(response["messageId"].as_str().unwrap_or_default())?;
            let (Some(question), Some(message)) = (question, message) else {
                return orchestration_err(
                    "operation_unknown",
                    format!("Legacy reply {} lost its durable effect.", key.operation_key),
                );
            };
            return Ok(LegacyQuestionCommit { receipt, question, message, duplicate: true });
        }

        let question = self.get_question(question_id)?;
        let source_message = self.get_message_by_id(question_id)?;
        let dispatch = match &question {
            Some(question) => self.dispatch_context_by_id(&question.dispatch_id)?,
            None => None,
        };
        let actionable = match (&question, &source_message, &dispatch) {
            (Some(question), Some(source), Some(dispatch)) => {
                question.run_id == principal.run_id
                    && source.delivery_contract.as_deref()
                        == Some(DELIVERY_CONTRACT_LEGACY_DIRECT)
                    && dispatch.run_id == principal.run_id
                    && dispatch.contract_version == LEGACY_CONTRACT_VERSION
                    && question.status != "closed"
            }
            _ => false,
        };
        if !actionable {
            return orchestration_err(
                "question_not_found",
                format!("Question {question_id} is not actionable in the adopted Run."),
            );
        }
        // `actionable` already proved the thread is present.
        let question = question.expect("actionable question row");

        let already_answered = question.status == "answered";
        let message = if already_answered {
            if question.answer_body.as_deref() != Some(body)
                || question.answer_message_id.is_none()
            {
                return orchestration_err(
                    "answer_conflict",
                    format!("Question {question_id} already has a different answer."),
                );
            }
            let recorded_id = question.answer_message_id.clone().unwrap_or_default();
            let recorded = self.get_message_by_id(&recorded_id)?;
            let Some(message) = recorded.filter(|message| {
                message.run_id == principal.run_id
                    && message.delivery_contract.as_deref()
                        == Some(DELIVERY_CONTRACT_LEGACY_DIRECT)
            }) else {
                return orchestration_err(
                    "operation_unknown",
                    format!("Question {question_id} lost its recorded answer message."),
                );
            };
            message
        } else {
            let message = self.insert_run_message(&NewRunMessage {
                id: self.legacy_generate_id("msg")?,
                run_id: principal.run_id.clone(),
                delivery_contract: DELIVERY_CONTRACT_LEGACY_DIRECT.to_string(),
                from_handle: principal.terminal_handle.clone(),
                to_handle: question.asker_handle.clone(),
                subject: "Re: Question".to_string(),
                body: body.to_string(),
                thread_id: Some(question.message_id.clone()),
                ..NewRunMessage::default()
            })?;
            self.mark_as_read(&[question.message_id.as_str()])?;
            self.db.connection().execute(
                "UPDATE question_threads
                 SET status = 'answered', answer_message_id = ?1, answer_body = ?2,
                     answered_at = datetime('now')
                 WHERE message_id = ?3 AND status = 'pending'",
                params![message.id, body, question.message_id],
            )?;
            message
        };

        let answered = self
            .get_question(question_id)?
            .ok_or_else(|| StoreError::Message("question thread vanished after answer".into()))?;
        let response = serde_json::to_string(&ReplyResponse {
            question_id: &answered.message_id,
            message_id: &message.id,
        })
        .map_err(|error| StoreError::Message(error.to_string()))?;
        let receipt = self.legacy_insert_operation_receipt(key, &message.id, &response)?;
        Ok(LegacyQuestionCommit {
            receipt,
            question: answered,
            message,
            duplicate: already_answered,
        })
    }

    /// TS `getLegacyAdoption`.
    pub fn get_legacy_adoption(&self) -> Result<Option<LegacyAdoption>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LEGACY_ADOPTION_COLUMNS} FROM legacy_adoptions WHERE source_run_id = ?1"
        ))?;
        Ok(stmt.query_row([LEGACY_RUN_ID], row_to_legacy_adoption).optional()?)
    }

    /// TS `getLegacyCompatibilityPrincipal`.
    pub fn get_legacy_compatibility_principal(
        &self,
        id: &str,
    ) -> Result<Option<LegacyCompatibilityPrincipal>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LEGACY_PRINCIPAL_COLUMNS} FROM legacy_compatibility_principals WHERE id = ?1"
        ))?;
        Ok(stmt.query_row([id], row_to_legacy_principal).optional()?)
    }

    /// TS `getLegacyCoordinatorPrincipal` — the single coordinator principal for
    /// a Run (enforced by `idx_legacy_principal_coordinator`).
    pub fn get_legacy_coordinator_principal(
        &self,
        run_id: &str,
    ) -> Result<Option<LegacyCompatibilityPrincipal>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LEGACY_PRINCIPAL_COLUMNS} FROM legacy_compatibility_principals
             WHERE run_id = ?1 AND role = 'coordinator'"
        ))?;
        Ok(stmt.query_row([run_id], row_to_legacy_principal).optional()?)
    }

    /// TS `getLegacyMailHistory` — newest-first history, never a recovery page.
    /// TS default limit 100, clamped to 100.
    ///
    /// (The TS `ORDER BY sequence ASC` is oldest-first; the doc comment's
    /// "newest-first" is the CLI's presentation, not the store's order.)
    pub fn get_legacy_mail_history(
        &self,
        principal_id: &str,
        limit: Option<i64>,
        types: Option<&[String]>,
    ) -> Result<LegacyMailPage, StoreError> {
        let principal = self.legacy_mail_principal(principal_id, None)?;
        let limit = limit.unwrap_or(100).max(1).min(100);
        let is_worker = principal.role == LEGACY_ROLE_WORKER;
        let address_sql =
            if is_worker { "(to_handle = ? OR to_handle = ?)" } else { "to_handle = ?" };
        let dispatch_address =
            format!("dispatch:{}", principal.dispatch_id.as_deref().unwrap_or_default());
        let type_sql = type_filter_clause("type", types);

        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages
             WHERE run_id = ? AND delivery_contract = 'legacy_direct'
               AND {address_sql}{type_sql}
             ORDER BY sequence ASC LIMIT ?"
        ))?;
        let mut binds: Vec<&dyn ToSql> = vec![&principal.run_id, &principal.terminal_handle];
        if is_worker {
            binds.push(&dispatch_address);
        }
        if let Some(types) = types.filter(|types| !types.is_empty()) {
            for message_type in types {
                binds.push(message_type as &dyn ToSql);
            }
        }
        binds.push(&limit);
        let rows = stmt.query_map(params_from_iter(binds), row_to_message)?;
        Ok(LegacyMailPage {
            messages: rows.collect::<rusqlite::Result<Vec<_>>>()?,
            recovery: false,
        })
    }

    /// TS `getLegacyMailPage` — the unacknowledged page a legacy poll consumes.
    /// TS default limit 50, clamped to 50.
    pub fn get_legacy_mail_page(
        &self,
        principal_id: &str,
        limit: Option<i64>,
        types: Option<&[String]>,
    ) -> Result<LegacyMailPage, StoreError> {
        let principal = self.legacy_mail_principal(principal_id, None)?;
        let limit = limit.unwrap_or(50).max(1).min(50);
        let is_worker = principal.role == LEGACY_ROLE_WORKER;
        let address_sql =
            if is_worker { "(m.to_handle = ? OR m.to_handle = ?)" } else { "m.to_handle = ?" };
        let dispatch_address =
            format!("dispatch:{}", principal.dispatch_id.as_deref().unwrap_or_default());
        let type_sql = type_filter_clause("m.type", types);
        let columns = message_columns_with_alias("m");
        let types = types.filter(|types| !types.is_empty());

        // Why: the recovery cohort is mail this principal was already shown before
        // the contract update, so it is replayed ahead of the live mailbox.
        let recovery = {
            let conn = self.db.connection();
            let mut stmt = conn.prepare(&format!(
                "SELECT {columns}
                 FROM legacy_mail_receipts r
                 INNER JOIN messages m ON m.id = r.message_id
                 WHERE r.principal_id = ? AND r.acknowledged_at IS NULL
                   AND m.run_id = ? AND m.delivery_contract = 'legacy_direct'
                   AND {address_sql}
                   {type_sql}
                 ORDER BY m.sequence ASC LIMIT ?"
            ))?;
            let mut binds: Vec<&dyn ToSql> =
                vec![&principal_id, &principal.run_id, &principal.terminal_handle];
            if is_worker {
                binds.push(&dispatch_address);
            }
            if let Some(types) = types {
                for message_type in types {
                    binds.push(message_type as &dyn ToSql);
                }
            }
            binds.push(&limit);
            let rows = stmt.query_map(params_from_iter(binds), row_to_message)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if !recovery.is_empty() {
            return Ok(LegacyMailPage { messages: recovery, recovery: true });
        }

        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {columns}
             FROM messages m
             LEFT JOIN legacy_mail_receipts r
               ON r.principal_id = ? AND r.message_id = m.id
             WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
               AND m.read = 0 AND r.message_id IS NULL AND {address_sql}
               {type_sql}
             ORDER BY m.sequence ASC LIMIT ?"
        ))?;
        let mut binds: Vec<&dyn ToSql> =
            vec![&principal_id, &principal.run_id, &principal.terminal_handle];
        if is_worker {
            binds.push(&dispatch_address);
        }
        if let Some(types) = types {
            for message_type in types {
                binds.push(message_type as &dyn ToSql);
            }
        }
        binds.push(&limit);
        let rows = stmt.query_map(params_from_iter(binds), row_to_message)?;
        Ok(LegacyMailPage {
            messages: rows.collect::<rusqlite::Result<Vec<_>>>()?,
            recovery: false,
        })
    }

    /// TS `getLegacyOperationReceipt`.
    pub fn get_legacy_operation_receipt(
        &self,
        principal_id: &str,
        operation_key: &str,
    ) -> Result<Option<LegacyOperationReceipt>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LEGACY_OPERATION_RECEIPT_COLUMNS} FROM legacy_operation_receipts
             WHERE principal_id = ?1 AND operation_key = ?2"
        ))?;
        Ok(stmt
            .query_row(params![principal_id, operation_key], row_to_legacy_operation_receipt)
            .optional()?)
    }

    /// TS `isLegacyCoordinatorHandle`.
    pub fn is_legacy_coordinator_handle(
        &self,
        run_id: &str,
        terminal_handle: &str,
    ) -> Result<bool, StoreError> {
        if let Some(principal) = self.get_legacy_coordinator_principal(run_id)? {
            return Ok(principal.terminal_handle == terminal_handle);
        }
        Ok(self.unique_legacy_coordinator_handle(run_id)?.as_deref() == Some(terminal_handle))
    }

    /// TS `listLegacyCompatibilityPrincipals`.
    pub fn list_legacy_compatibility_principals(
        &self,
        run_id: &str,
    ) -> Result<Vec<LegacyCompatibilityPrincipal>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LEGACY_PRINCIPAL_COLUMNS} FROM legacy_compatibility_principals
             WHERE run_id = ?1 ORDER BY rowid"
        ))?;
        let rows = stmt.query_map([run_id], row_to_legacy_principal)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// TS `resolveLegacyCompatibilityPrincipalByIdentity`.
    pub fn resolve_legacy_compatibility_principal_by_identity(
        &self,
        query: &LegacyIdentityQuery,
    ) -> Result<Option<LegacyCompatibilityPrincipal>, StoreError> {
        let terminal_handle = query.terminal_handle.as_deref().filter(|it| !it.is_empty());
        let pane_key = query.pane_key.as_deref().filter(|it| !it.is_empty());
        if terminal_handle.is_none() && pane_key.is_none() {
            return Ok(None);
        }
        // The TS signature makes these required; an absent one can match nothing.
        let (Some(run_id), Some(role)) = (query.run_id.as_deref(), query.role.as_deref()) else {
            return Ok(None);
        };
        let rows: Vec<LegacyCompatibilityPrincipal> = {
            let conn = self.db.connection();
            let mut stmt = conn.prepare(&format!(
                "SELECT {LEGACY_PRINCIPAL_COLUMNS} FROM legacy_compatibility_principals
                 WHERE run_id = ?1 AND role = ?2 AND status IN ('committed', 'settled')
                 ORDER BY rowid"
            ))?;
            let rows = stmt.query_map(params![run_id, role], row_to_legacy_principal)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let matched: Vec<LegacyCompatibilityPrincipal> = rows
            .into_iter()
            .filter(|principal| match pane_key {
                Some(pane_key) => is_equivalent_pane_key(&principal.pane_key, pane_key),
                None => Some(principal.terminal_handle.as_str()) == terminal_handle,
            })
            .collect();
        if matched.len() > 1 {
            return orchestration_err(
                "operation_unknown",
                "Multiple legacy principals match this process identity.",
            );
        }
        Ok(matched.into_iter().next())
    }

    /// TS `resolveLegacyCoordinatorCandidate` — who to address when no
    /// coordinator principal has committed yet.
    pub fn resolve_legacy_coordinator_candidate(
        &self,
        query: &LegacyIdentityQuery,
    ) -> Result<Option<LegacyCoordinatorCandidate>, StoreError> {
        let (Some(terminal_handle), Some(pane_key)) = (
            query.terminal_handle.as_deref().filter(|it| !it.is_empty()),
            query.pane_key.as_deref().filter(|it| !it.is_empty()),
        ) else {
            return Ok(None);
        };
        let Some(run_id) = query.run_id.as_deref() else {
            return Ok(None);
        };
        let candidate = LegacyCoordinatorCandidate {
            terminal_handle: terminal_handle.to_string(),
            pane_key: pane_key.to_string(),
        };
        let run = self.get_run(run_id)?;
        if let Some(principal) = self.get_legacy_coordinator_principal(run_id)? {
            if principal.status != "committed"
                || principal.terminal_handle != terminal_handle
                || !is_equivalent_pane_key(&principal.pane_key, pane_key)
            {
                return Ok(None);
            }
            // Why: `run?.coordinator_pane_key !== null` is true for a MISSING run
            // too (undefined !== null), and the inner compare then fails — so an
            // unknown Run is not a candidate.
            let binding_ok = match &run {
                None => false,
                Some(run) => match run.coordinator_pane_key.as_deref() {
                    None => true,
                    Some(run_pane_key) => {
                        run.coordinator_handle.as_deref() == Some(principal.terminal_handle.as_str())
                            && is_equivalent_pane_key(run_pane_key, &principal.pane_key)
                    }
                },
            };
            return Ok(binding_ok.then_some(candidate));
        }
        // Why: the first current binding durably fences uncommitted legacy processes.
        let unbound = run.is_some_and(|run| run.coordinator_pane_key.is_none());
        if !unbound
            || self.unique_legacy_coordinator_handle(run_id)?.as_deref() != Some(terminal_handle)
        {
            return Ok(None);
        }
        Ok(Some(candidate))
    }

    /// TS `resolveLegacyWorkerCandidate` — the dispatch a legacy worker call
    /// belongs to, resolved from whatever identity fields it presented.
    pub fn resolve_legacy_worker_candidate(
        &self,
        query: &LegacyIdentityQuery,
    ) -> Result<Option<DispatchContext>, StoreError> {
        let terminal_handle = query.terminal_handle.as_deref().filter(|it| !it.is_empty());
        let pane_key = query.pane_key.as_deref().filter(|it| !it.is_empty());
        let Some(run_id) = query.run_id.as_deref().filter(|it| !it.is_empty()) else {
            return Ok(None);
        };
        if terminal_handle.is_none() && pane_key.is_none() {
            return Ok(None);
        }
        let dispatch_id = query.dispatch_id.as_deref().filter(|it| !it.is_empty());
        let task_id = query.task_id.as_deref().filter(|it| !it.is_empty());

        let candidates: Vec<DispatchContext> = match dispatch_id {
            Some(dispatch_id) => self.dispatch_context_by_id(dispatch_id)?.into_iter().collect(),
            None => {
                let conn = self.db.connection();
                let mut stmt = conn.prepare(&format!(
                    "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts
                     WHERE run_id = ?1 AND contract_version = ?2
                       AND status IN ('pending', 'dispatched')
                     ORDER BY rowid"
                ))?;
                let rows =
                    stmt.query_map(params![run_id, LEGACY_CONTRACT_VERSION], row_to_dispatch)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        let matched: Vec<DispatchContext> = candidates
            .into_iter()
            .filter(|dispatch| {
                dispatch.run_id == run_id
                    && dispatch.contract_version == LEGACY_CONTRACT_VERSION
                    && task_id.is_none_or(|task_id| dispatch.task_id == task_id)
                    && match pane_key {
                        Some(pane_key) => dispatch
                            .assignee_pane_key
                            .as_deref()
                            .is_some_and(|key| is_equivalent_pane_key(key, pane_key)),
                        None => dispatch.assignee_handle.as_deref() == terminal_handle,
                    }
            })
            .collect();
        if matched.len() > 1 {
            return orchestration_err(
                "operation_unknown",
                "Multiple active legacy Dispatches match this process identity.",
            );
        }
        if let (Some(dispatch_id), true) = (dispatch_id, matched.is_empty()) {
            let target = self.dispatch_context_by_id(dispatch_id)?;
            if target.is_some_and(|target| target.contract_version == LEGACY_CONTRACT_VERSION) {
                return orchestration_err(
                    "legacy_read_only",
                    format!(
                        "Dispatch {dispatch_id} is retained but this process cannot prove ownership."
                    ),
                );
            }
        }
        Ok(matched.into_iter().next())
    }

    /// TS `findLegacyWorkerCompletion` — the already-sent `worker_done` matching
    /// a retried completion, identified semantically.
    pub fn find_legacy_worker_completion(
        &self,
        query: &LegacyWorkerCompletionQuery,
    ) -> Result<Option<Message>, StoreError> {
        let principal = self.get_legacy_compatibility_principal(&query.principal_id)?;
        let Some(principal) = principal.filter(|principal| {
            principal.role == LEGACY_ROLE_WORKER && principal.dispatch_id.is_some()
        }) else {
            return orchestration_err("request_mismatch", "Legacy worker principal was not found.");
        };
        let run_address = format!("run:{}", principal.run_id);
        let rows: Vec<Message> = {
            let conn = self.db.connection();
            let mut stmt = conn.prepare(&format!(
                "SELECT {MESSAGE_COLUMNS} FROM messages
                 WHERE run_id = ?1
                   AND (
                     (delivery_contract = 'legacy_direct' AND to_handle = ?2) OR
                     (delivery_contract = 'current_delivery' AND to_handle = ?3)
                   )
                   AND from_handle = ?4 AND type = 'worker_done'
                   AND subject = ?5 AND body = ?6 AND payload IS ?7
                 ORDER BY sequence"
            ))?;
            let rows = stmt.query_map(
                params![
                    principal.run_id,
                    query.recipient_handle,
                    run_address,
                    principal.terminal_handle,
                    query.subject,
                    query.body,
                    query.payload,
                ],
                row_to_message,
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let dispatch_id = principal.dispatch_id.as_deref().unwrap_or_default();
        let matches: Vec<Message> = rows
            .into_iter()
            .filter(|message| {
                let Some(payload) = message
                    .payload
                    .as_deref()
                    .and_then(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
                else {
                    return false;
                };
                payload.get("taskId").and_then(|it| it.as_str()) == Some(query.task_id.as_str())
                    && payload.get("dispatchId").and_then(|it| it.as_str()) == Some(dispatch_id)
            })
            .collect();
        if matches.len() > 1 {
            return orchestration_err(
                "operation_unknown",
                "Multiple matching legacy worker completions exist.",
            );
        }
        Ok(matches.into_iter().next())
    }

    /// TS `setLegacyCompatibilityPrincipalStatus` — settle or revoke a committed
    /// principal (a no-op against any other status).
    pub fn set_legacy_compatibility_principal_status(
        &self,
        id: &str,
        status: &str,
    ) -> Result<Option<LegacyCompatibilityPrincipal>, StoreError> {
        self.db.connection().execute(
            "UPDATE legacy_compatibility_principals
             SET status = ?1
             WHERE id = ?2 AND status = 'committed'",
            params![status, id],
        )?;
        self.get_legacy_compatibility_principal(id)
    }

    // -----------------------------------------------------------------------
    // Domain-private helpers
    //
    // These port the TS privates that belong to this domain. Every cross-domain
    // seam calls the owning module's version:
    // `messages::insert_run_message`,
    // `runs::{get_run, unique_legacy_coordinator_handle}`,
    // `worker_dispatch::settle_worker_report_in_transaction`,
    // `questions::{get_question, close_questions_for_dispatch}`.
    // -----------------------------------------------------------------------

    /// TS `requireCommittedLegacyPrincipal`. `pub(crate)`: `questions` gates its
    /// legacy semantic-identity search on the same principal check.
    pub(crate) fn legacy_committed_principal(
        &self,
        principal_id: &str,
        role: Option<&str>,
    ) -> Result<LegacyCompatibilityPrincipal, StoreError> {
        let principal = self.get_legacy_compatibility_principal(principal_id)?;
        match principal.filter(|principal| {
            principal.status == "committed" && role.is_none_or(|role| principal.role == role)
        }) {
            Some(principal) => Ok(principal),
            None => orchestration_err(
                "request_mismatch",
                format!(
                    "Legacy compatibility principal {principal_id} is not committed for this operation."
                ),
            ),
        }
    }

    /// TS `requireLegacyMailPrincipal` — retained mail stays readable after the
    /// principal settles, so `settled` is admitted alongside `committed`.
    fn legacy_mail_principal(
        &self,
        principal_id: &str,
        role: Option<&str>,
    ) -> Result<LegacyCompatibilityPrincipal, StoreError> {
        let principal = self.get_legacy_compatibility_principal(principal_id)?;
        match principal.filter(|principal| {
            (principal.status == "committed" || principal.status == "settled")
                && role.is_none_or(|role| principal.role == role)
        }) {
            Some(principal) => Ok(principal),
            None => orchestration_err(
                "request_mismatch",
                format!(
                    "Legacy compatibility principal {principal_id} cannot access retained mail."
                ),
            ),
        }
    }

    /// TS `initializeLegacyRecoveryCohort` — the already-read mail this principal
    /// must be shown again, because the pre-Run process consumed it without a
    /// durable receipt.
    fn legacy_initialize_recovery_cohort(
        &self,
        principal: &LegacyCompatibilityPrincipal,
    ) -> Result<(), StoreError> {
        if principal.role == LEGACY_ROLE_WORKER {
            let dispatch_address =
                format!("dispatch:{}", principal.dispatch_id.as_deref().unwrap_or_default());
            self.db.connection().execute(
                "INSERT OR IGNORE INTO legacy_mail_receipts (
                   principal_id, message_id, acknowledged_at
                 )
                 SELECT ?1, m.id, NULL
                 FROM messages m
                 INNER JOIN dispatch_contexts d ON d.id = ?2
                 WHERE m.run_id = ?3 AND m.delivery_contract = 'legacy_direct' AND m.read = 1
                   AND d.status IN ('pending', 'dispatched')
                   AND m.created_at >= d.created_at
                   AND (m.to_handle = ?4 OR m.to_handle = ?5)",
                params![
                    principal.id,
                    principal.dispatch_id,
                    principal.run_id,
                    principal.terminal_handle,
                    dispatch_address,
                ],
            )?;
            return Ok(());
        }
        self.db.connection().execute(
            "INSERT OR IGNORE INTO legacy_mail_receipts (
               principal_id, message_id, acknowledged_at
             )
             SELECT ?1, m.id, NULL
             FROM messages m
             WHERE m.run_id = ?2 AND m.delivery_contract = 'legacy_direct' AND m.read = 1
               AND m.to_handle = ?3
               AND EXISTS(
                 SELECT 1 FROM dispatch_contexts d
                 WHERE d.run_id = m.run_id
                   AND d.contract_version = ?4
                   AND d.status IN ('pending', 'dispatched')
                   AND m.created_at >= d.created_at
                   AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
               )",
            params![
                principal.id,
                principal.run_id,
                principal.terminal_handle,
                LEGACY_CONTRACT_VERSION,
            ],
        )?;
        Ok(())
    }

    /// TS `requireMatchingLegacyOperationReceipt` — the recorded receipt for this
    /// key, refusing a replay that carries different input.
    fn legacy_matching_operation_receipt(
        &self,
        key: &LegacyOperationKey,
    ) -> Result<Option<LegacyOperationReceipt>, StoreError> {
        let receipt = self.get_legacy_operation_receipt(&key.principal_id, &key.operation_key)?;
        if let Some(receipt) = &receipt {
            if receipt.method != key.method || receipt.payload_hash != key.payload_hash {
                return orchestration_err(
                    "request_mismatch",
                    format!(
                        "Legacy operation {} was already used with different input.",
                        key.operation_key
                    ),
                );
            }
        }
        Ok(receipt)
    }

    /// TS `insertLegacyOperationReceipt`.
    fn legacy_insert_operation_receipt(
        &self,
        key: &LegacyOperationKey,
        effect_id: &str,
        response_json: &str,
    ) -> Result<LegacyOperationReceipt, StoreError> {
        self.db.connection().execute(
            "INSERT INTO legacy_operation_receipts (
               principal_id, operation_key, method, payload_hash, effect_id, response_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                key.principal_id,
                key.operation_key,
                key.method,
                key.payload_hash,
                effect_id,
                response_json,
            ],
        )?;
        self.get_legacy_operation_receipt(&key.principal_id, &key.operation_key)?
            .ok_or_else(|| StoreError::Message("legacy operation receipt vanished".into()))
    }

    /// The `legacy_mail_receipts` upsert shared by both acknowledgement paths —
    /// `COALESCE` keeps the FIRST acknowledgement stamp on a replay.
    fn legacy_record_mail_receipt(
        &self,
        principal_id: &str,
        message_id: &str,
    ) -> Result<(), StoreError> {
        self.db.connection().execute(
            "INSERT INTO legacy_mail_receipts (
               principal_id, message_id, acknowledged_at
             ) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(principal_id, message_id)
             DO UPDATE SET acknowledged_at = COALESCE(
               legacy_mail_receipts.acknowledged_at, excluded.acknowledged_at
             )",
            params![principal_id, message_id],
        )?;
        Ok(())
    }

    fn legacy_mail_receipt(
        &self,
        principal_id: &str,
        message_id: &str,
    ) -> Result<Option<LegacyMailReceipt>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LEGACY_MAIL_RECEIPT_COLUMNS} FROM legacy_mail_receipts
             WHERE principal_id = ?1 AND message_id = ?2"
        ))?;
        Ok(stmt
            .query_row(params![principal_id, message_id], row_to_legacy_mail_receipt)
            .optional()?)
    }

    /// TS `resolveLegacyWorkerCoordinatorDelivery` — once a current consumer holds
    /// the coordinator seat, legacy worker mail is re-routed to the Run mailbox.
    fn legacy_worker_coordinator_delivery(
        &self,
        run_id: &str,
        retained_coordinator_handle: &str,
    ) -> Result<LegacyDelivery, StoreError> {
        let run = self.get_run(run_id)?;
        let principal = self.get_legacy_coordinator_principal(run_id)?;
        // `run?.coordinator_handle !== null` is also true for a missing run.
        let bound = run.map_or(true, |run| run.coordinator_handle.is_some());
        let retained =
            principal.as_ref().map(|principal| principal.status.as_str()) == Some("committed");
        if bound && !retained {
            return Ok(LegacyDelivery {
                to: format!("run:{run_id}"),
                contract: DELIVERY_CONTRACT_CURRENT.to_string(),
            });
        }
        Ok(LegacyDelivery {
            to: retained_coordinator_handle.to_string(),
            contract: DELIVERY_CONTRACT_LEGACY_DIRECT.to_string(),
        })
    }

    /// TS `generateId(prefix)` — `randomBytes(6).toString('hex')`, minted by
    /// SQLite so no RNG dependency is added for a handful of ids.
    fn legacy_generate_id(&self, prefix: &str) -> Result<String, StoreError> {
        generate_id(&self.db, prefix)
    }
}

/// `MESSAGE_COLUMNS` qualified with a table alias — the shared reader still
/// indexes positionally, so the order must not change.
fn message_columns_with_alias(alias: &str) -> String {
    MESSAGE_COLUMNS
        .split(", ")
        .map(|column| format!("{alias}.{column}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The TS `value ?? fallback` for a field Rust models as a non-optional `String`.
fn default_if_empty(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

/// Read a `WorkerReportSettlement` back out of a stored `response_json`.
///
/// Why hand-rolled: the shared enum derives `Serialize` only, and it lives in
/// `worker_dispatch`, so a replayed receipt has to be decoded here.
fn settlement_from_json(value: Option<&serde_json::Value>) -> Option<WorkerReportSettlement> {
    let value = value?;
    match value.get("action").and_then(|action| action.as_str())? {
        "settled" => Some(WorkerReportSettlement::Settled {
            outcome: value.get("outcome")?.as_str()?.to_string(),
            duplicate: value.get("duplicate").and_then(|it| it.as_bool()).unwrap_or(false),
        }),
        "rejected" => Some(WorkerReportSettlement::Rejected {
            code: value.get("code")?.as_str()?.to_string(),
            reason: value.get("reason")?.as_str()?.to_string(),
        }),
        _ => None,
    }
}

/// TS `generateId(prefix)` against a bare `Database` — the migration path mints
/// the adopted Run id before any store value exists.
fn generate_id(db: &Database, prefix: &str) -> Result<String, StoreError> {
    Ok(db.connection().query_row(
        "SELECT ?1 || '_' || lower(hex(randomblob(6)))",
        [prefix],
        |row| row.get(0),
    )?)
}

// ---------------------------------------------------------------------------
// Migration hooks — called from `orchestration_schema::migrate`
// ---------------------------------------------------------------------------
//
// These take `&Database` rather than `&OrchestrationDb` because they run inside
// `migrate`, before a store value exists — and inside its `BEGIN IMMEDIATE`, so
// none of them may open a transaction of their own.

/// TS `classifyLegacyMessageContracts` — stamps `legacy_direct` on a run's mail,
/// demoting rows that carry the lifecycle-rejection marker to `audit_only`.
pub(crate) fn classify_legacy_message_contracts(
    db: &Database,
    run_id: &str,
    adopted_only: bool,
) -> Result<(), StoreError> {
    // Why: on the adopted Run only rows this migration already claimed are
    // re-classified, so mail written by a current consumer is left alone.
    let contract_filter = if adopted_only {
        " AND delivery_contract IN ('legacy_direct', 'audit_only')"
    } else {
        ""
    };
    let conn = db.connection();
    conn.execute(
        &format!(
            "UPDATE messages SET delivery_contract = 'legacy_direct'
             WHERE run_id = ?1{contract_filter}"
        ),
        [run_id],
    )?;
    let rows: Vec<(String, Option<String>)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, payload FROM messages WHERE run_id = ?1{contract_filter}"
        ))?;
        let rows = stmt.query_map([run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, payload) in rows {
        if has_lifecycle_rejection_marker(payload.as_deref()) {
            conn.execute(
                "UPDATE messages SET delivery_contract = 'audit_only' WHERE id = ?1 AND run_id = ?2",
                params![id, run_id],
            )?;
        }
    }
    Ok(())
}

/// TS `adoptLegacyRunIfNeeded` — re-homes the synthetic legacy Run's graph onto a
/// real Run and records the adoption (including whether scheduler state was lost).
pub(crate) fn adopt_legacy_run_if_needed(db: &Database) -> Result<(), StoreError> {
    let conn = db.connection();
    let existing: Option<String> = conn
        .query_row(
            "SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = ?1",
            [LEGACY_RUN_ID],
            |row| row.get(0),
        )
        .optional()?;
    let has_graph: Option<i64> = conn
        .query_row(
            "SELECT 1
             WHERE EXISTS(SELECT 1 FROM tasks WHERE run_id = ?1)
                OR EXISTS(SELECT 1 FROM dispatch_contexts WHERE run_id = ?1)
                OR EXISTS(SELECT 1 FROM decision_gates WHERE run_id = ?1)
                OR EXISTS(SELECT 1 FROM messages WHERE run_id = ?1)
                OR EXISTS(SELECT 1 FROM question_threads WHERE run_id = ?1)
                OR EXISTS(SELECT 1 FROM deliveries WHERE run_id = ?1)",
            [LEGACY_RUN_ID],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_none() && has_graph.is_none() {
        return Ok(());
    }

    let adopted_run_id = match existing {
        Some(id) => id,
        None => generate_id(db, "run")?,
    };
    conn.execute(
        "INSERT OR IGNORE INTO runs (
           id, objective, home_database, consumer_generation, legacy
         ) VALUES (?1, ?2, 'this_database', 0, 0)",
        params![adopted_run_id, "Recovered orchestration work from a contract update"],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO legacy_adoptions (
           source_run_id, adopted_run_id, scheduler_state_lost
         ) VALUES (?1, ?2, 1)",
        params![LEGACY_RUN_ID, adopted_run_id],
    )?;
    // Why: a coordinator still 'running' at adoption time lost its scheduler with
    // the contract update — record that as provenance rather than leaving it live.
    conn.execute(
        "UPDATE coordinator_runs
         SET status = 'failed',
             completed_at = COALESCE(
               completed_at,
               (SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?1)
             ),
             scheduler_lost_at = (
               SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?1
             )
         WHERE status = 'running'
           AND julianday(created_at) <= julianday((
             SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?1
           ))",
        [LEGACY_RUN_ID],
    )?;
    conn.execute(
        "UPDATE deliveries SET status = 'fenced'
         WHERE run_id = ?1 AND status = 'outstanding'",
        [LEGACY_RUN_ID],
    )?;
    for table in
        ["tasks", "dispatch_contexts", "decision_gates", "messages", "question_threads", "deliveries"]
    {
        conn.execute(
            &format!("UPDATE {table} SET run_id = ?1 WHERE run_id = ?2"),
            params![adopted_run_id, LEGACY_RUN_ID],
        )?;
    }
    conn.execute(
        "UPDATE runs
         SET objective = 'Legacy orchestration state (adopted; inspect only)',
             coordinator_handle = NULL, coordinator_pane_key = NULL,
             updated_at = datetime('now')
         WHERE id = ?1",
        [LEGACY_RUN_ID],
    )?;

    let mismatch: Option<i64> = conn
        .query_row(
            "WITH migration_runs(run_id) AS (VALUES (?1), (?2))
             SELECT 1
             WHERE EXISTS(
               SELECT 1 FROM dispatch_contexts d
               INNER JOIN tasks t ON t.id = d.task_id
               WHERE d.run_id <> t.run_id
                 AND (
                   d.run_id IN (SELECT run_id FROM migration_runs)
                   OR t.run_id IN (SELECT run_id FROM migration_runs)
                 )
             )
                OR EXISTS(
                  SELECT 1 FROM decision_gates g
                  INNER JOIN tasks t ON t.id = g.task_id
                  WHERE g.run_id <> t.run_id
                    AND (
                      g.run_id IN (SELECT run_id FROM migration_runs)
                      OR t.run_id IN (SELECT run_id FROM migration_runs)
                    )
                )
                OR EXISTS(
                  SELECT 1 FROM question_threads q
                  INNER JOIN dispatch_contexts d ON d.id = q.dispatch_id
                  WHERE q.run_id <> d.run_id
                    AND (
                      q.run_id IN (SELECT run_id FROM migration_runs)
                      OR d.run_id IN (SELECT run_id FROM migration_runs)
                    )
                )
                OR EXISTS(
                  SELECT 1 FROM deliveries d
                  INNER JOIN json_each(d.message_ids) ids
                  INNER JOIN messages m ON m.id = ids.value
                  WHERE d.run_id <> m.run_id
                    AND (
                      d.run_id IN (SELECT run_id FROM migration_runs)
                      OR m.run_id IN (SELECT run_id FROM migration_runs)
                    )
                )",
            params![LEGACY_RUN_ID, adopted_run_id],
            |row| row.get(0),
        )
        .optional()?;
    if mismatch.is_some() {
        // The TS twin throws a bare Error here, not a coded one.
        return Err(StoreError::Message(
            "Legacy orchestration adoption produced inconsistent Run ownership.".to_string(),
        ));
    }
    Ok(())
}

/// TS `backfillLegacyQuestionThreads` — reconstructs `question_threads` rows for
/// `question` messages that predate the table.
pub(crate) fn backfill_legacy_question_threads(db: &Database) -> Result<(), StoreError> {
    struct GateMessage {
        id: String,
        run_id: String,
        from_handle: String,
        to_handle: String,
        payload: Option<String>,
        created_at: String,
        sequence: i64,
    }
    let conn = db.connection();
    let messages: Vec<GateMessage> = {
        let mut stmt = conn.prepare(
            "SELECT id, run_id, from_handle, to_handle, payload, created_at, sequence
             FROM messages
             WHERE type = 'decision_gate'
               AND delivery_contract IN ('legacy_direct', 'current_delivery')
             ORDER BY sequence",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(GateMessage {
                id: row.get(0)?,
                run_id: row.get(1)?,
                from_handle: row.get(2)?,
                to_handle: row.get(3)?,
                payload: row.get(4)?,
                created_at: row.get(5)?,
                sequence: row.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for message in messages {
        let Ok(payload) =
            serde_json::from_str::<serde_json::Value>(message.payload.as_deref().unwrap_or("{}"))
        else {
            continue;
        };
        let payload_dispatch_id = payload.get("dispatchId").and_then(|it| it.as_str());
        let payload_task_id = payload.get("taskId").and_then(|it| it.as_str());

        // (dispatch id, run id, task id)
        let dispatch: Option<(String, String, String)> = match payload_dispatch_id {
            Some(dispatch_id) => conn
                .query_row(
                    "SELECT id, run_id, task_id FROM dispatch_contexts
                     WHERE id = ?1 AND contract_version = ?2",
                    params![dispatch_id, LEGACY_CONTRACT_VERSION],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?,
            None => {
                // Why: with no recorded dispatch id, the ask can only be attributed
                // when exactly ONE legacy dispatch was live for that sender.
                let mut stmt = conn.prepare(
                    "SELECT id, run_id, task_id
                     FROM dispatch_contexts
                     WHERE contract_version = ?1 AND assignee_handle = ?2
                       AND (?3 IS NULL OR task_id = ?4)
                       AND created_at <= ?5
                       AND (completed_at IS NULL OR completed_at >= ?6)
                     ORDER BY rowid
                     LIMIT 2",
                )?;
                let rows = stmt.query_map(
                    params![
                        LEGACY_CONTRACT_VERSION,
                        message.from_handle,
                        payload_task_id,
                        payload_task_id,
                        message.created_at,
                        message.created_at
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                let inferred = rows.collect::<rusqlite::Result<Vec<_>>>()?;
                if inferred.len() == 1 {
                    inferred.into_iter().next()
                } else {
                    None
                }
            }
        };
        let Some((dispatch_id, dispatch_run_id, dispatch_task_id)) = dispatch else {
            continue;
        };
        if payload_task_id.is_some_and(|task_id| task_id != dispatch_task_id) {
            continue;
        }
        if message.run_id != LEGACY_RUN_ID && message.run_id != dispatch_run_id {
            continue;
        }

        // (answer id, body, created_at)
        let answer: Option<(String, String, String)> = conn
            .query_row(
                "SELECT id, body, created_at
                 FROM messages
                 WHERE run_id = ?1
                   AND thread_id = ?2
                   AND delivery_contract IN ('legacy_direct', 'current_delivery')
                   AND from_handle = ?3
                   AND to_handle IN (?4, ?5)
                   AND sequence > ?6
                 ORDER BY sequence
                 LIMIT 1",
                params![
                    message.run_id,
                    message.id,
                    message.to_handle,
                    message.from_handle,
                    format!("dispatch:{dispatch_id}"),
                    message.sequence
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (answer_id, answer_body, answered_at) = match &answer {
            Some((id, body, created_at)) => {
                (Some(id.as_str()), Some(body.as_str()), Some(created_at.as_str()))
            }
            None => (None, None, None),
        };
        conn.execute(
            "INSERT OR IGNORE INTO question_threads (
               message_id, run_id, dispatch_id, asker_handle, status,
               answer_message_id, answer_body, created_at, answered_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                message.id,
                dispatch_run_id,
                dispatch_id,
                message.from_handle,
                if answer.is_some() { "answered" } else { "pending" },
                answer_id,
                answer_body,
                message.created_at,
                answered_at,
            ],
        )?;
    }

    // Why: a revoked legacy coordinator's still-actionable mail has to move to the
    // Run mailbox, or the current consumer never sees it.
    let adoption: Option<String> = conn
        .query_row(
            "SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = ?1",
            [LEGACY_RUN_ID],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(adopted_run_id) = adoption {
        let coordinator: Option<(String, String)> = conn
            .query_row(
                "SELECT terminal_handle, status FROM legacy_compatibility_principals
                 WHERE run_id = ?1 AND role = 'coordinator'",
                [&adopted_run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((terminal_handle, status)) = coordinator {
            if status == "revoked" {
                promote_legacy_coordinator_mail(
                    conn,
                    &adopted_run_id,
                    Some(&terminal_handle),
                )?;
            }
        }
    }
    Ok(())
}

/// The adopted Run id, if the legacy Run has been adopted. Read directly (not via
/// `OrchestrationDb`) because `migrate` needs it before the store exists.
pub(crate) fn adopted_legacy_run_id(db: &Database) -> Result<Option<String>, StoreError> {
    Ok(db
        .connection()
        .query_row(
            "SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = ?1",
            [LEGACY_RUN_ID],
            |row| row.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests;
