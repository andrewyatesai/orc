//! The worker side of a federated dispatch: this Orca is the peer, running work
//! a remote home owns. Mirrors `worker_dispatch`'s state machine on the
//! `remote_dispatch_attachments` table, with its own capability/pane authority
//! because the home cannot vouch for a local process.
//!
//! Ported from the remote attachment section of
//! `src/main/runtime/orchestration/db.ts`.
//! Tables: `remote_dispatch_attachments`, `mutation_receipts`.

use super::capability::{
    constant_time_hex_eq, hash_dispatch_capability, mint_dispatch_capability_token, present,
};
use super::error::OrchestrationError;
use super::mutation_receipt::MutationReceiptKey;
use super::pane_key::is_equivalent_pane_key;
use super::rows::{row_to_remote_attachment, RemoteDispatchAttachment, REMOTE_ATTACHMENT_COLUMNS};
use super::sql_fragments::json_array_text;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension};

/// TS `createRemoteDispatchAttachment(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateRemoteAttachmentParams {
    pub dispatch_id: String,
    pub task_id: String,
    pub home_peer_fingerprint: String,
    pub protocol_version: i64,
    pub runtime_epoch: String,
    pub mutation_receipt: MutationReceiptKey,
}

/// TS `recordRemoteAttachmentStage(params)` — partial update; absent fields are
/// left unchanged.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteAttachmentStageUpdate {
    pub dispatch_id: String,
    pub stage: String,
    pub state: Option<String>,
    pub worktree_id: Option<String>,
    pub terminal_handle: Option<String>,
    pub setup_state: Option<String>,
    pub effects: Option<Vec<serde_json::Value>>,
    pub residual_resources: Option<Vec<serde_json::Value>>,
    pub last_error: Option<String>,
}

/// TS `{ attachment; changed }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct RemoteAttachmentSetupEvidence {
    pub attachment: RemoteDispatchAttachment,
    pub changed: bool,
}

/// TS `prepareRemoteAttachmentAuthority(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrepareRemoteAttachmentAuthorityParams {
    pub dispatch_id: String,
    pub pane_key: String,
    pub process_incarnation: String,
    pub worktree_id: String,
    pub terminal_handle: String,
    pub setup_state: String,
    pub effects: Vec<serde_json::Value>,
}

/// TS `verifyRemoteAttachmentAuthority(params)` / `isRemoteAttachmentProcessCurrent`
/// — the presented identity, any field of which may legitimately be absent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteAttachmentIdentity {
    pub dispatch_id: String,
    pub capability: Option<String>,
    pub pane_key: Option<String>,
    pub process_incarnation: Option<String>,
}

fn remote_attachment_not_found(dispatch_id: &str) -> StoreError {
    OrchestrationError::new(
        "dispatch_not_found",
        format!("Remote Dispatch {dispatch_id} was not found."),
    )
    .into()
}

fn remote_attachment_not_starting(dispatch_id: &str) -> StoreError {
    OrchestrationError::new(
        "dispatch_inactive",
        format!("Remote Dispatch {dispatch_id} is not starting."),
    )
    .into()
}

/// TS `params.effects.filter(...)` in `prepareRemoteAttachmentAuthority`: only
/// effects that created a resource (or reused the agent terminal) are residual —
/// they are what a later teardown has to reclaim.
fn residual_resource_effects(effects: &[serde_json::Value]) -> Vec<serde_json::Value> {
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

impl OrchestrationDb {
    /// TS `createRemoteDispatchAttachment`.
    pub fn create_remote_dispatch_attachment(
        &self,
        params: &CreateRemoteAttachmentParams,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        let staged = self.stage_remote_dispatch_attachment(params);
        match staged {
            Ok(()) => self.db.exec("COMMIT")?,
            Err(error) => {
                // Why: the rollback must not mask the original failure, which is
                // the coded error the RPC layer branches on.
                let _ = self.db.exec("ROLLBACK");
                return Err(error);
            }
        }
        self.get_remote_dispatch_attachment(&params.dispatch_id)?
            .ok_or_else(|| remote_attachment_not_found(&params.dispatch_id))
    }

    /// The body of `createRemoteDispatchAttachment`'s `BEGIN IMMEDIATE` block.
    fn stage_remote_dispatch_attachment(
        &self,
        params: &CreateRemoteAttachmentParams,
    ) -> Result<(), StoreError> {
        let receipt = &params.mutation_receipt;
        if params.home_peer_fingerprint != receipt.caller_fingerprint {
            return Err(OrchestrationError::new(
                "resource_server_mismatch",
                "The authenticated Run-home peer does not match the attachment request.",
            )
            .into());
        }
        if let Some(existing) =
            self.get_mutation_receipt(&receipt.caller_fingerprint, &receipt.request_id)?
        {
            // Same request replayed verbatim: the outcome is not knowable from
            // here, so the caller is told the operation exists, never re-run.
            let code = if existing.method == receipt.method
                && existing.payload_hash == receipt.payload_hash
            {
                "operation_unknown"
            } else {
                "request_mismatch"
            };
            return Err(OrchestrationError::new(
                code,
                format!("Remote attachment request {} already exists.", receipt.request_id),
            )
            .into());
        }
        self.ensure_mutation_receipt_capacity()?;
        let conn = self.db.connection();
        conn.execute(
            "INSERT INTO mutation_receipts (
               caller_fingerprint, request_id, method, payload_hash, state, receipt
             ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
            params![
                receipt.caller_fingerprint,
                receipt.request_id,
                receipt.method,
                receipt.payload_hash,
                serde_json::json!({ "accepted": { "dispatchId": params.dispatch_id } }).to_string(),
            ],
        )?;
        conn.execute(
            "INSERT INTO remote_dispatch_attachments (
               dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                params.dispatch_id,
                params.task_id,
                params.home_peer_fingerprint,
                params.protocol_version,
                params.runtime_epoch,
            ],
        )?;
        Ok(())
    }

    /// TS `getRemoteDispatchAttachment`.
    pub fn get_remote_dispatch_attachment(
        &self,
        dispatch_id: &str,
    ) -> Result<Option<RemoteDispatchAttachment>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {REMOTE_ATTACHMENT_COLUMNS} FROM remote_dispatch_attachments WHERE dispatch_id = ?1"
        ))?;
        Ok(stmt.query_row([dispatch_id], row_to_remote_attachment).optional()?)
    }

    /// The post-update re-read every mutating method ends with. The TS casts a
    /// possibly-`undefined` row to the row type; a vanished row is a coded
    /// `dispatch_not_found` here rather than a null that reaches a caller typed
    /// as present.
    fn remote_attachment_or_missing(
        &self,
        dispatch_id: &str,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        self.get_remote_dispatch_attachment(dispatch_id)?
            .ok_or_else(|| remote_attachment_not_found(dispatch_id))
    }

    /// TS `findActiveRemoteAttachmentForPane` — resolves by pane-key equivalence
    /// (see [`super::pane_key`]), not by handle.
    pub fn find_active_remote_attachment_for_pane(
        &self,
        pane_key: &str,
    ) -> Result<Option<RemoteDispatchAttachment>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {REMOTE_ATTACHMENT_COLUMNS} FROM remote_dispatch_attachments
             WHERE state IN ('starting', 'ready') AND pane_key IS NOT NULL
             ORDER BY rowid DESC"
        ))?;
        let rows = stmt.query_map([], row_to_remote_attachment)?;
        for row in rows {
            let row = row?;
            if row.pane_key.as_deref().is_some_and(|key| is_equivalent_pane_key(key, pane_key)) {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }

    /// TS `markRemoteAttachmentReady`.
    pub fn mark_remote_attachment_ready(
        &self,
        dispatch_id: &str,
        effects: Option<&[serde_json::Value]>,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        let effects = effects.map(json_array_text);
        let changes = self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET state = 'ready', stage = 'input_accepted',
                 effects = COALESCE(?1, effects), updated_at = datetime('now')
             WHERE dispatch_id = ?2 AND state = 'starting'",
            params![effects, dispatch_id],
        )?;
        if changes != 1 {
            return Err(remote_attachment_not_starting(dispatch_id));
        }
        self.remote_attachment_or_missing(dispatch_id)
    }

    /// TS `markRemoteAttachmentStopUnknown`.
    pub fn mark_remote_attachment_stop_unknown(
        &self,
        dispatch_id: &str,
        reason: &str,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET state = 'stop_unknown', stage = 'stop_outcome_unknown', last_error = ?1,
                 updated_at = datetime('now')
             WHERE dispatch_id = ?2 AND state = 'stopping'",
            params![reason, dispatch_id],
        )?;
        self.remote_attachment_or_missing(dispatch_id)
    }

    /// TS `beginRemoteAttachmentStop`.
    pub fn begin_remote_attachment_stop(
        &self,
        dispatch_id: &str,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        let attachment = self
            .get_remote_dispatch_attachment(dispatch_id)?
            .ok_or_else(|| remote_attachment_not_found(dispatch_id))?;
        if matches!(attachment.state.as_str(), "succeeded" | "failed" | "stopped" | "abandoned") {
            return Ok(attachment);
        }
        if !matches!(attachment.state.as_str(), "ready" | "start_unknown") {
            return Err(OrchestrationError::new(
                "dispatch_inactive",
                format!(
                    "Remote Dispatch {dispatch_id} cannot stop from {}.",
                    attachment.state
                ),
            )
            .into());
        }
        self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET state = 'stopping', stage = 'stop_requested', capability_hash = NULL,
                 updated_at = datetime('now')
             WHERE dispatch_id = ?1 AND state IN ('ready', 'start_unknown')",
            params![dispatch_id],
        )?;
        self.remote_attachment_or_missing(dispatch_id)
    }

    /// TS `settleRemoteAttachmentStop`.
    pub fn settle_remote_attachment_stop(
        &self,
        dispatch_id: &str,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET state = 'stopped', stage = 'process_stopped', updated_at = datetime('now')
             WHERE dispatch_id = ?1 AND state = 'stopping'",
            params![dispatch_id],
        )?;
        self.remote_attachment_or_missing(dispatch_id)
    }

    /// TS `failRemoteAttachment` — `unknown` picks `start_unknown` over `failed`.
    pub fn fail_remote_attachment(
        &self,
        dispatch_id: &str,
        stage: &str,
        reason: &str,
        unknown: bool,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        let state = if unknown { "start_unknown" } else { "failed" };
        let changes = self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET state = ?1, stage = ?2, last_error = ?3, capability_hash = NULL,
                 updated_at = datetime('now')
             WHERE dispatch_id = ?4 AND state = 'starting'",
            params![state, stage, reason, dispatch_id],
        )?;
        if changes != 1 {
            return Err(remote_attachment_not_starting(dispatch_id));
        }
        self.remote_attachment_or_missing(dispatch_id)
    }

    /// TS `recordRemoteAttachmentStage`.
    pub fn record_remote_attachment_stage(
        &self,
        update: &RemoteAttachmentStageUpdate,
    ) -> Result<RemoteDispatchAttachment, StoreError> {
        let current = self
            .get_remote_dispatch_attachment(&update.dispatch_id)?
            .ok_or_else(|| remote_attachment_not_found(&update.dispatch_id))?;
        // Absent fields re-write the current value: the TS `??` fallbacks, which
        // also mean an explicit column reset is not expressible here.
        let state = update.state.as_ref().unwrap_or(&current.state);
        let worktree_id = update.worktree_id.as_ref().or(current.worktree_id.as_ref());
        let terminal_handle = update.terminal_handle.as_ref().or(current.terminal_handle.as_ref());
        let setup_state = update.setup_state.as_ref().unwrap_or(&current.setup_state);
        let effects = match &update.effects {
            Some(effects) => json_array_text(effects),
            None => current.effects.clone(),
        };
        let residual_resources = match &update.residual_resources {
            Some(resources) => json_array_text(resources),
            None => current.residual_resources.clone(),
        };
        let last_error = update.last_error.as_ref().or(current.last_error.as_ref());
        self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET stage = ?1, state = ?2, worktree_id = ?3, terminal_handle = ?4, setup_state = ?5,
                 effects = ?6, residual_resources = ?7, last_error = ?8, updated_at = datetime('now')
             WHERE dispatch_id = ?9",
            params![
                update.stage,
                state,
                worktree_id,
                terminal_handle,
                setup_state,
                effects,
                residual_resources,
                last_error,
                update.dispatch_id,
            ],
        )?;
        self.remote_attachment_or_missing(&update.dispatch_id)
    }

    /// TS `updateRemoteAttachmentSetupEvidence`.
    pub fn update_remote_attachment_setup_evidence(
        &self,
        dispatch_id: &str,
        setup_state: &str,
        effects: &[serde_json::Value],
    ) -> Result<RemoteAttachmentSetupEvidence, StoreError> {
        let current = self
            .get_remote_dispatch_attachment(dispatch_id)?
            .ok_or_else(|| remote_attachment_not_found(dispatch_id))?;
        let effects = json_array_text(effects);
        if current.setup_state == setup_state && current.effects == effects {
            return Ok(RemoteAttachmentSetupEvidence { attachment: current, changed: false });
        }
        self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET setup_state = ?1, effects = ?2, updated_at = datetime('now')
             WHERE dispatch_id = ?3",
            params![setup_state, effects, dispatch_id],
        )?;
        Ok(RemoteAttachmentSetupEvidence {
            attachment: self.remote_attachment_or_missing(dispatch_id)?,
            changed: true,
        })
    }

    /// TS `prepareRemoteAttachmentAuthority` — returns the minted capability.
    pub fn prepare_remote_attachment_authority(
        &self,
        params: &PrepareRemoteAttachmentAuthorityParams,
    ) -> Result<String, StoreError> {
        let attachment = self.get_remote_dispatch_attachment(&params.dispatch_id)?;
        if !attachment.is_some_and(|row| row.state == "starting") {
            return Err(remote_attachment_not_starting(&params.dispatch_id));
        }
        let capability = mint_dispatch_capability_token()?;
        self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET stage = 'authority_attached', capability_hash = ?1, pane_key = ?2,
                 process_incarnation = ?3, worktree_id = ?4, terminal_handle = ?5, setup_state = ?6,
                 effects = ?7, residual_resources = ?8, updated_at = datetime('now')
             WHERE dispatch_id = ?9 AND state = 'starting'",
            params![
                hash_dispatch_capability(&capability),
                params.pane_key,
                params.process_incarnation,
                params.worktree_id,
                params.terminal_handle,
                params.setup_state,
                json_array_text(&params.effects),
                json_array_text(&residual_resource_effects(&params.effects)),
                params.dispatch_id,
            ],
        )?;
        Ok(capability)
    }

    /// TS `verifyRemoteAttachmentAuthority` — constant-time capability compare
    /// plus the pane/incarnation currency check.
    pub fn verify_remote_attachment_authority(
        &self,
        identity: &RemoteAttachmentIdentity,
    ) -> Result<bool, StoreError> {
        let Some(attachment) = self.get_remote_dispatch_attachment(&identity.dispatch_id)? else {
            return Ok(false);
        };
        let Some(stored_hash) = present(attachment.capability_hash.as_deref()) else {
            return Ok(false);
        };
        let Some(capability) = present(identity.capability.as_deref()) else {
            return Ok(false);
        };
        if !self.remote_attachment_identity_is_current(&attachment, identity) {
            return Ok(false);
        }
        // Constant-time, with the explicit length guard the TS keeps in front of
        // `timingSafeEqual` — this gates whether a launched process may act.
        Ok(constant_time_hex_eq(stored_hash, &hash_dispatch_capability(capability)))
    }

    /// TS `isRemoteAttachmentProcessCurrent` — pane/incarnation only, no capability.
    pub fn is_remote_attachment_process_current(
        &self,
        identity: &RemoteAttachmentIdentity,
    ) -> Result<bool, StoreError> {
        let Some(attachment) = self.get_remote_dispatch_attachment(&identity.dispatch_id)? else {
            return Ok(false);
        };
        Ok(self.remote_attachment_identity_is_current(&attachment, identity))
    }

    /// The pane/incarnation half both authority checks share: the stored pane key
    /// must be equivalent (remint-stable leaf) to the presented one, and the
    /// process incarnation must match exactly.
    fn remote_attachment_identity_is_current(
        &self,
        attachment: &RemoteDispatchAttachment,
        identity: &RemoteAttachmentIdentity,
    ) -> bool {
        let Some(stored_pane) = present(attachment.pane_key.as_deref()) else {
            return false;
        };
        let Some(presented_pane) = present(identity.pane_key.as_deref()) else {
            return false;
        };
        if !is_equivalent_pane_key(stored_pane, presented_pane) {
            return false;
        }
        let Some(incarnation) = present(attachment.process_incarnation.as_deref()) else {
            return false;
        };
        Some(incarnation) == identity.process_incarnation.as_deref()
    }

    /// TS `setRemoteWorkerImportSequence` — the worker's `to_worker` import
    /// watermark, the mirror of `setFederatedHomeImportSequence`.
    pub fn set_remote_worker_import_sequence(
        &self,
        dispatch_id: &str,
        sequence: i64,
    ) -> Result<(), StoreError> {
        // Why: the `<` guard makes the watermark monotonic, so an out-of-order
        // import replay cannot rewind it.
        self.db.connection().execute(
            "UPDATE remote_dispatch_attachments
             SET to_worker_imported_sequence = ?1, updated_at = datetime('now')
             WHERE dispatch_id = ?2 AND to_worker_imported_sequence < ?1",
            params![sequence, dispatch_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEAF: &str = "0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
    const OTHER_LEAF: &str = "1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d";

    fn code_of(error: &StoreError) -> String {
        let StoreError::Message(text) = error else {
            panic!("expected a coded message error, got {error:?}");
        };
        let parsed: serde_json::Value =
            serde_json::from_str(text).unwrap_or_else(|_| panic!("not a coded error: {text}"));
        parsed["code"].as_str().expect("coded error has a code").to_string()
    }

    fn receipt(request_id: &str) -> MutationReceiptKey {
        MutationReceiptKey {
            caller_fingerprint: "home-peer".to_string(),
            request_id: request_id.to_string(),
            method: "attachRemoteDispatch".to_string(),
            payload_hash: "hash-1".to_string(),
        }
    }

    fn create_params(dispatch_id: &str, request_id: &str) -> CreateRemoteAttachmentParams {
        CreateRemoteAttachmentParams {
            dispatch_id: dispatch_id.to_string(),
            task_id: "task-1".to_string(),
            home_peer_fingerprint: "home-peer".to_string(),
            protocol_version: 3,
            runtime_epoch: "epoch-1".to_string(),
            mutation_receipt: receipt(request_id),
        }
    }

    fn store() -> OrchestrationDb {
        OrchestrationDb::open_in_memory().unwrap()
    }

    fn attached(db: &OrchestrationDb, dispatch_id: &str) -> RemoteDispatchAttachment {
        db.create_remote_dispatch_attachment(&create_params(dispatch_id, dispatch_id)).unwrap()
    }

    fn authority(db: &OrchestrationDb, dispatch_id: &str, pane_key: &str) -> String {
        db.prepare_remote_attachment_authority(&PrepareRemoteAttachmentAuthorityParams {
            dispatch_id: dispatch_id.to_string(),
            pane_key: pane_key.to_string(),
            process_incarnation: "inc-1".to_string(),
            worktree_id: "wt-1".to_string(),
            terminal_handle: "term-1".to_string(),
            setup_state: "ready".to_string(),
            effects: vec![
                serde_json::json!({ "action": "created_worktree", "id": "wt-1" }),
                serde_json::json!({ "action": "inspected", "id": "noop" }),
                serde_json::json!({ "action": "reused_agent_terminal", "id": "term-1" }),
            ],
        })
        .unwrap()
    }

    fn force_state(db: &OrchestrationDb, dispatch_id: &str, state: &str) {
        db.connection()
            .execute(
                "UPDATE remote_dispatch_attachments SET state = ?2 WHERE dispatch_id = ?1",
                params![dispatch_id, state],
            )
            .unwrap();
    }

    #[test]
    fn create_seeds_the_row_defaults_and_a_pending_receipt() {
        let db = store();
        let row = attached(&db, "rd1");
        assert_eq!(row.dispatch_id, "rd1");
        assert_eq!(row.task_id, "task-1");
        assert_eq!(row.home_peer_fingerprint, "home-peer");
        assert_eq!(row.protocol_version, 3);
        assert_eq!(row.runtime_epoch, "epoch-1");
        assert_eq!(row.state, "starting");
        assert_eq!(row.stage, "accepted");
        assert_eq!(row.setup_state, "not_applicable");
        assert_eq!(row.effects, "[]");
        assert_eq!(row.residual_resources, "[]");
        assert_eq!(row.to_worker_imported_sequence, 0);
        assert_eq!(row.capability_hash, None);
        assert!(!row.created_at.is_empty());

        let (state, receipt): (String, String) = db
            .connection()
            .query_row(
                "SELECT state, receipt FROM mutation_receipts WHERE request_id = 'rd1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending");
        assert_eq!(receipt, r#"{"accepted":{"dispatchId":"rd1"}}"#);
        assert_eq!(db.get_remote_dispatch_attachment("missing").unwrap(), None);
    }

    #[test]
    fn create_rejects_a_peer_mismatch_and_rolls_the_receipt_back() {
        let db = store();
        let mut params = create_params("rd1", "req-1");
        params.home_peer_fingerprint = "other-peer".to_string();
        let error = db.create_remote_dispatch_attachment(&params).unwrap_err();
        assert_eq!(code_of(&error), "resource_server_mismatch");
        assert_eq!(db.get_remote_dispatch_attachment("rd1").unwrap(), None);
        let receipts: i64 = db
            .connection()
            .query_row("SELECT COUNT(*) FROM mutation_receipts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(receipts, 0);
    }

    #[test]
    fn create_replays_are_operation_unknown_and_altered_payloads_are_request_mismatch() {
        let db = store();
        attached(&db, "rd1");

        // Same (method, payload_hash) under the same request id: the outcome is
        // not knowable from here, so it is never re-applied.
        let replay = db.create_remote_dispatch_attachment(&create_params("rd2", "rd1")).unwrap_err();
        assert_eq!(code_of(&replay), "operation_unknown");

        let mut altered = create_params("rd3", "rd1");
        altered.mutation_receipt.payload_hash = "hash-2".to_string();
        let mismatch = db.create_remote_dispatch_attachment(&altered).unwrap_err();
        assert_eq!(code_of(&mismatch), "request_mismatch");
        assert_eq!(db.get_remote_dispatch_attachment("rd2").unwrap(), None);
        assert_eq!(db.get_remote_dispatch_attachment("rd3").unwrap(), None);
    }

    #[test]
    fn record_stage_leaves_absent_fields_untouched() {
        let db = store();
        attached(&db, "rd1");
        db.record_remote_attachment_stage(&RemoteAttachmentStageUpdate {
            dispatch_id: "rd1".to_string(),
            stage: "worktree_ready".to_string(),
            worktree_id: Some("wt-1".to_string()),
            effects: Some(vec![serde_json::json!({ "action": "created_worktree" })]),
            last_error: Some("transient".to_string()),
            ..Default::default()
        })
        .unwrap();
        let row = db
            .record_remote_attachment_stage(&RemoteAttachmentStageUpdate {
                dispatch_id: "rd1".to_string(),
                stage: "terminal_ready".to_string(),
                terminal_handle: Some("term-1".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(row.stage, "terminal_ready");
        assert_eq!(row.state, "starting");
        assert_eq!(row.worktree_id.as_deref(), Some("wt-1"));
        assert_eq!(row.terminal_handle.as_deref(), Some("term-1"));
        assert_eq!(row.effects, r#"[{"action":"created_worktree"}]"#);
        assert_eq!(row.residual_resources, "[]");
        // TS `??` keeps the prior error rather than clearing it.
        assert_eq!(row.last_error.as_deref(), Some("transient"));

        let missing = db
            .record_remote_attachment_stage(&RemoteAttachmentStageUpdate {
                dispatch_id: "nope".to_string(),
                stage: "worktree_ready".to_string(),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(code_of(&missing), "dispatch_not_found");
    }

    #[test]
    fn setup_evidence_reports_changed_only_when_it_differs() {
        let db = store();
        attached(&db, "rd1");
        let effects = vec![serde_json::json!({ "action": "created_worktree" })];
        let first =
            db.update_remote_attachment_setup_evidence("rd1", "running", &effects).unwrap();
        assert!(first.changed);
        assert_eq!(first.attachment.setup_state, "running");
        let repeat =
            db.update_remote_attachment_setup_evidence("rd1", "running", &effects).unwrap();
        assert!(!repeat.changed);
        assert_eq!(repeat.attachment, first.attachment);
        let moved = db.update_remote_attachment_setup_evidence("rd1", "ready", &effects).unwrap();
        assert!(moved.changed);

        let missing =
            db.update_remote_attachment_setup_evidence("nope", "ready", &effects).unwrap_err();
        assert_eq!(code_of(&missing), "dispatch_not_found");
    }

    #[test]
    fn prepare_authority_binds_identity_and_keeps_only_created_effects_as_residual() {
        let db = store();
        attached(&db, "rd1");
        let capability = authority(&db, "rd1", &format!("tab1:{LEAF}"));
        assert!(capability.starts_with("dcap_"));
        assert_eq!(capability.len(), "dcap_".len() + 43);

        let row = db.get_remote_dispatch_attachment("rd1").unwrap().unwrap();
        assert_eq!(row.stage, "authority_attached");
        assert_eq!(row.state, "starting");
        assert_eq!(row.pane_key.as_deref(), Some(format!("tab1:{LEAF}").as_str()));
        assert_eq!(row.process_incarnation.as_deref(), Some("inc-1"));
        assert_eq!(row.worktree_id.as_deref(), Some("wt-1"));
        assert_eq!(row.terminal_handle.as_deref(), Some("term-1"));
        assert_eq!(row.setup_state, "ready");
        assert_eq!(
            row.capability_hash.as_deref(),
            Some(hash_dispatch_capability(&capability).as_str())
        );
        let residual: Vec<serde_json::Value> =
            serde_json::from_str(&row.residual_resources).unwrap();
        assert_eq!(residual.len(), 2);
        assert_eq!(residual[0]["action"], "created_worktree");
        assert_eq!(residual[1]["action"], "reused_agent_terminal");

        // Only a `starting` attachment may be given authority.
        force_state(&db, "rd1", "ready");
        let error = db
            .prepare_remote_attachment_authority(&PrepareRemoteAttachmentAuthorityParams {
                dispatch_id: "rd1".to_string(),
                pane_key: format!("tab1:{LEAF}"),
                process_incarnation: "inc-2".to_string(),
                worktree_id: "wt-1".to_string(),
                terminal_handle: "term-1".to_string(),
                setup_state: "ready".to_string(),
                effects: vec![],
            })
            .unwrap_err();
        assert_eq!(code_of(&error), "dispatch_inactive");
        // The rejected attempt left the bound identity alone.
        let after = db.get_remote_dispatch_attachment("rd1").unwrap().unwrap();
        assert_eq!(after.process_incarnation.as_deref(), Some("inc-1"));
    }

    #[test]
    fn verify_authority_accepts_a_remint_and_refuses_every_broken_field() {
        let db = store();
        attached(&db, "rd1");
        let capability = authority(&db, "rd1", &format!("tab1:{LEAF}"));
        let identity = |capability: Option<&str>, pane: Option<&str>, inc: Option<&str>| {
            RemoteAttachmentIdentity {
                dispatch_id: "rd1".to_string(),
                capability: capability.map(str::to_string),
                pane_key: pane.map(str::to_string),
                process_incarnation: inc.map(str::to_string),
            }
        };
        let tab1 = format!("tab1:{LEAF}");
        let tab2 = format!("tab2:{LEAF}");
        let other = format!("tab1:{OTHER_LEAF}");

        assert!(db
            .verify_remote_attachment_authority(&identity(
                Some(&capability),
                Some(&tab1),
                Some("inc-1")
            ))
            .unwrap());
        // A reminted tab keeps the same stable leaf, so authority survives.
        assert!(db
            .verify_remote_attachment_authority(&identity(
                Some(&capability),
                Some(&tab2),
                Some("inc-1")
            ))
            .unwrap());
        assert!(!db
            .verify_remote_attachment_authority(&identity(
                Some("dcap_wrong"),
                Some(&tab1),
                Some("inc-1")
            ))
            .unwrap());
        assert!(!db
            .verify_remote_attachment_authority(&identity(None, Some(&tab1), Some("inc-1")))
            .unwrap());
        assert!(!db
            .verify_remote_attachment_authority(&identity(Some(""), Some(&tab1), Some("inc-1")))
            .unwrap());
        assert!(!db
            .verify_remote_attachment_authority(&identity(
                Some(&capability),
                Some(&other),
                Some("inc-1")
            ))
            .unwrap());
        assert!(!db
            .verify_remote_attachment_authority(&identity(Some(&capability), None, Some("inc-1")))
            .unwrap());
        assert!(!db
            .verify_remote_attachment_authority(&identity(
                Some(&capability),
                Some(&tab1),
                Some("inc-2")
            ))
            .unwrap());
        assert!(!db
            .verify_remote_attachment_authority(&identity(Some(&capability), Some(&tab1), None))
            .unwrap());
        // Unknown dispatch, and a dispatch that never minted a capability.
        assert!(!db
            .verify_remote_attachment_authority(&RemoteAttachmentIdentity {
                dispatch_id: "nope".to_string(),
                capability: Some(capability.clone()),
                pane_key: Some(tab1.clone()),
                process_incarnation: Some("inc-1".to_string()),
            })
            .unwrap());
        attached(&db, "rd2");
        assert!(!db
            .verify_remote_attachment_authority(&RemoteAttachmentIdentity {
                dispatch_id: "rd2".to_string(),
                capability: Some(capability.clone()),
                pane_key: Some(tab1.clone()),
                process_incarnation: Some("inc-1".to_string()),
            })
            .unwrap());

        // The currency probe is the same check minus the capability.
        assert!(db
            .is_remote_attachment_process_current(&identity(None, Some(&tab2), Some("inc-1")))
            .unwrap());
        assert!(!db
            .is_remote_attachment_process_current(&identity(None, Some(&other), Some("inc-1")))
            .unwrap());
        assert!(!db
            .is_remote_attachment_process_current(&identity(None, Some(&tab1), Some("inc-2")))
            .unwrap());
        assert!(!db
            .is_remote_attachment_process_current(&RemoteAttachmentIdentity {
                dispatch_id: "rd2".to_string(),
                pane_key: Some(tab1.clone()),
                process_incarnation: Some("inc-1".to_string()),
                ..Default::default()
            })
            .unwrap());
    }

    #[test]
    fn ready_only_leaves_starting_and_absent_effects_are_preserved() {
        let db = store();
        attached(&db, "rd1");
        db.update_remote_attachment_setup_evidence(
            "rd1",
            "running",
            &[serde_json::json!({ "action": "created_worktree" })],
        )
        .unwrap();

        let row = db.mark_remote_attachment_ready("rd1", None).unwrap();
        assert_eq!(row.state, "ready");
        assert_eq!(row.stage, "input_accepted");
        // COALESCE(NULL, effects) keeps the evidence already recorded.
        assert_eq!(row.effects, r#"[{"action":"created_worktree"}]"#);

        let error = db.mark_remote_attachment_ready("rd1", None).unwrap_err();
        assert_eq!(code_of(&error), "dispatch_inactive");

        attached(&db, "rd2");
        let replaced = db
            .mark_remote_attachment_ready("rd2", Some(&[serde_json::json!({ "action": "noop" })]))
            .unwrap();
        assert_eq!(replaced.effects, r#"[{"action":"noop"}]"#);
    }

    #[test]
    fn fail_picks_start_unknown_for_unknown_and_clears_the_capability() {
        let db = store();
        attached(&db, "rd1");
        authority(&db, "rd1", &format!("tab1:{LEAF}"));
        let failed = db.fail_remote_attachment("rd1", "worktree", "boom", false).unwrap();
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.stage, "worktree");
        assert_eq!(failed.last_error.as_deref(), Some("boom"));
        assert_eq!(failed.capability_hash, None);

        // Already settled: no second transition out of `starting`.
        let error = db.fail_remote_attachment("rd1", "worktree", "boom", true).unwrap_err();
        assert_eq!(code_of(&error), "dispatch_inactive");

        attached(&db, "rd2");
        let unknown = db.fail_remote_attachment("rd2", "terminal", "no answer", true).unwrap();
        assert_eq!(unknown.state, "start_unknown");
    }

    #[test]
    fn stop_walks_ready_to_stopping_to_stopped_and_is_idempotent_when_settled() {
        let db = store();
        attached(&db, "rd1");
        authority(&db, "rd1", &format!("tab1:{LEAF}"));
        db.mark_remote_attachment_ready("rd1", None).unwrap();

        let stopping = db.begin_remote_attachment_stop("rd1").unwrap();
        assert_eq!(stopping.state, "stopping");
        assert_eq!(stopping.stage, "stop_requested");
        assert_eq!(stopping.capability_hash, None);

        let stopped = db.settle_remote_attachment_stop("rd1").unwrap();
        assert_eq!(stopped.state, "stopped");
        assert_eq!(stopped.stage, "process_stopped");

        // A terminal attachment is returned unchanged, not re-transitioned.
        let again = db.begin_remote_attachment_stop("rd1").unwrap();
        assert_eq!(again, stopped);

        // `starting` is neither terminal nor stoppable.
        attached(&db, "rd2");
        let error = db.begin_remote_attachment_stop("rd2").unwrap_err();
        assert_eq!(code_of(&error), "dispatch_inactive");
        assert_eq!(code_of(&db.begin_remote_attachment_stop("nope").unwrap_err()), "dispatch_not_found");

        // `start_unknown` is stoppable; the stop outcome may itself be unknown.
        attached(&db, "rd3");
        db.fail_remote_attachment("rd3", "terminal", "no answer", true).unwrap();
        assert_eq!(db.begin_remote_attachment_stop("rd3").unwrap().state, "stopping");
        let unknown = db.mark_remote_attachment_stop_unknown("rd3", "kill timed out").unwrap();
        assert_eq!(unknown.state, "stop_unknown");
        assert_eq!(unknown.stage, "stop_outcome_unknown");
        assert_eq!(unknown.last_error.as_deref(), Some("kill timed out"));
        // The guard is `state = 'stopping'`, so a repeat is a no-op, not a throw.
        let repeat = db.mark_remote_attachment_stop_unknown("rd3", "second").unwrap();
        assert_eq!(repeat.last_error.as_deref(), Some("kill timed out"));
        assert_eq!(db.settle_remote_attachment_stop("rd3").unwrap().state, "stop_unknown");
    }

    #[test]
    fn find_active_for_pane_takes_the_newest_equivalent_live_row() {
        let db = store();
        for (index, dispatch) in ["rd1", "rd2", "rd3"].iter().enumerate() {
            attached(&db, dispatch);
            authority(&db, dispatch, &format!("tab{index}:{LEAF}"));
        }
        db.mark_remote_attachment_ready("rd2", None).unwrap();
        // rowid DESC → the newest attachment on the pane wins.
        let found = db.find_active_remote_attachment_for_pane(&format!("tab9:{LEAF}")).unwrap();
        assert_eq!(found.unwrap().dispatch_id, "rd3");

        // Settled rows drop out of the candidate set.
        db.fail_remote_attachment("rd3", "terminal", "boom", false).unwrap();
        db.fail_remote_attachment("rd1", "terminal", "boom", false).unwrap();
        let found = db.find_active_remote_attachment_for_pane(&format!("tab9:{LEAF}")).unwrap();
        assert_eq!(found.unwrap().dispatch_id, "rd2");

        // A different leaf is a different pane.
        assert_eq!(
            db.find_active_remote_attachment_for_pane(&format!("tab0:{OTHER_LEAF}")).unwrap(),
            None
        );
        // An attachment with no pane key is never a candidate.
        attached(&db, "rd4");
        assert_eq!(db.find_active_remote_attachment_for_pane("rd4").unwrap(), None);
    }

    #[test]
    fn import_sequence_advances_but_never_rewinds() {
        let db = store();
        attached(&db, "rd1");
        db.set_remote_worker_import_sequence("rd1", 5).unwrap();
        assert_eq!(
            db.get_remote_dispatch_attachment("rd1").unwrap().unwrap().to_worker_imported_sequence,
            5
        );
        db.set_remote_worker_import_sequence("rd1", 3).unwrap();
        assert_eq!(
            db.get_remote_dispatch_attachment("rd1").unwrap().unwrap().to_worker_imported_sequence,
            5
        );
        db.set_remote_worker_import_sequence("rd1", 9).unwrap();
        assert_eq!(
            db.get_remote_dispatch_attachment("rd1").unwrap().unwrap().to_worker_imported_sequence,
            9
        );
        // An unknown dispatch is a silent no-op, exactly as in the TS.
        db.set_remote_worker_import_sequence("nope", 9).unwrap();
    }

    #[test]
    fn every_capability_mint_is_fresh() {
        assert_ne!(
            mint_dispatch_capability_token().unwrap(),
            mint_dispatch_capability_token().unwrap()
        );
    }
}
