//! `OrchestrationStore` — the Node-API surface of `orca_runtime`'s multi-agent
//! orchestration store, which the main-process `OrchestrationDb` shim in
//! `src/main/runtime/orchestration/db.ts` delegates to (the node:sqlite twin was
//! deleted). JS-side nondeterminism (generated ids, ISO completion stamps,
//! display strings) is passed IN by the shim; every other timestamp uses SQLite
//! `datetime('now')` — byte-identical to what the deleted TS store wrote.
//!
//! Marshalling contract:
//! * Rows and composed results cross as JSON strings (`row_json`); serde output
//!   matches the TS Row shapes in types.ts, so the shim only parses and applies
//!   its `expose*Timestamps` rewrites.
//! * Nullable single-row reads cross as `Option<String>` → `string | null`.
//! * Arguments stay positional — this surface has no params-object methods.
//! * Store errors reach JS through `napi_err`, which puts the `StoreError` text
//!   in `Error.message` verbatim, so a coded envelope survives for the shim to
//!   branch on. Nothing here re-wraps or reformats it.

use napi_derive::napi;

use orca_runtime::orchestration::{
    DispatchIdentity, MintCapabilityParams, NewAuditEvent, NewGatePolicy, NewMessage,
    NewRotationReservation, OrchestrationDb,
};

fn napi_err<E: std::fmt::Display>(err: E) -> napi::Error {
    napi::Error::from_reason(err.to_string())
}

fn row_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[napi(js_name = "OrchestrationStore")]
pub struct JsOrchestrationStore {
    // Option so close() can drop the connection deterministically (WAL lock
    // release matters on Windows); calls after close() throw.
    inner: Option<OrchestrationDb>,
}

impl JsOrchestrationStore {
    fn store(&self) -> napi::Result<&OrchestrationDb> {
        self.inner
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("OrchestrationStore is closed"))
    }
}

#[napi]
impl JsOrchestrationStore {
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> napi::Result<Self> {
        let inner = if path == ":memory:" {
            OrchestrationDb::open_in_memory()
        } else {
            OrchestrationDb::open(&path)
        }
        .map_err(napi_err)?;
        Ok(Self { inner: Some(inner) })
    }

    // ---- messages ----

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn insert_message(
        &self,
        id: String,
        from_handle: String,
        to_handle: String,
        subject: String,
        body: String,
        message_type: String,
        priority: String,
        thread_id: Option<String>,
        payload: Option<String>,
        sender_pane_key: Option<String>,
        recipient_pane_key: Option<String>,
    ) -> napi::Result<String> {
        let message = NewMessage { id, from_handle, to_handle, subject, body, message_type, priority, thread_id, payload, sender_pane_key, recipient_pane_key };
        self.store()?.send_message(&message).map(|m| row_json(&m)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_message_by_id(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_message_by_id(&id).map_err(napi_err)?.map(|m| row_json(&m)))
    }

    #[napi(catch_unwind)]
    pub fn get_unread_messages(&self, handle: String, types: Option<Vec<String>>) -> napi::Result<String> {
        self.store()?.get_unread_messages(&handle, types.as_deref()).map(|m| row_json(&m)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_undelivered_unread_messages(&self, handle: String, types: Option<Vec<String>>) -> napi::Result<String> {
        self.store()?
            .get_undelivered_unread_messages(&handle, types.as_deref())
            .map(|m| row_json(&m))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_all_messages(&self, handle: String, limit: f64) -> napi::Result<String> {
        self.store()?.get_all_messages(&handle, limit as i64).map(|m| row_json(&m)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_all_messages_for_handle(&self, handle: String, limit: f64, types: Option<Vec<String>>) -> napi::Result<String> {
        self.store()?
            .get_all_messages_for_handle(&handle, limit as i64, types.as_deref())
            .map(|m| row_json(&m))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_inbox(&self, limit: f64) -> napi::Result<String> {
        self.store()?.get_inbox(limit as i64).map(|m| row_json(&m)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_thread_messages_for(&self, thread_id: String, to_handle: String, after_sequence: Option<f64>) -> napi::Result<String> {
        self.store()?
            .get_thread_messages_for(&thread_id, &to_handle, after_sequence.map(|n| n as i64))
            .map(|m| row_json(&m))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn mark_as_read(&self, ids: Vec<String>) -> napi::Result<()> {
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        self.store()?.mark_as_read(&refs).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn mark_as_read_and_delivered(&self, ids: Vec<String>) -> napi::Result<()> {
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        self.store()?.mark_as_read_and_delivered(&refs).map_err(napi_err)
    }

    /// `code` (trailing, optional so existing callers are unchanged) selects the
    /// persisted marker code; absent keeps the historic `sender_not_assignee`.
    #[napi(catch_unwind)]
    pub fn convert_lifecycle_message_to_rejection(&self, message_id: String, reason: String, code: Option<String>) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .convert_lifecycle_message_to_rejection(&message_id, &reason, code.as_deref())
            .map_err(napi_err)?
            .map(|m| row_json(&m)))
    }

    #[napi(catch_unwind)]
    pub fn mark_as_delivered(&self, ids: Vec<String>) -> napi::Result<()> {
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        self.store()?.mark_as_delivered(&refs).map_err(napi_err)
    }

    // ---- tasks ----

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &self,
        id: String,
        spec: String,
        parent_id: Option<String>,
        deps: Vec<String>,
        created_by: Option<String>,
        task_title: Option<String>,
        display_name: Option<String>,
        run_id: Option<String>,
    ) -> napi::Result<String> {
        let deps: Vec<&str> = deps.iter().map(String::as_str).collect();
        self.store()?
            .create_task(&id, &spec, parent_id.as_deref(), &deps, created_by.as_deref(), task_title.as_deref(), display_name.as_deref(), run_id.as_deref())
            .map(|t| row_json(&t))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_task(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_task(&id).map_err(napi_err)?.map(|t| row_json(&t)))
    }

    #[napi(catch_unwind)]
    pub fn list_tasks(&self, status: Option<String>, run_id: Option<String>) -> napi::Result<String> {
        self.store()?.list_tasks(status.as_deref(), run_id.as_deref()).map(|t| row_json(&t)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn list_tasks_with_dispatch(&self, status: Option<String>) -> napi::Result<String> {
        self.store()?.list_tasks_with_dispatch(status.as_deref()).map(|t| row_json(&t)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn update_task_status(
        &self,
        id: String,
        status: String,
        result: Option<String>,
        completed_at: Option<String>,
    ) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .update_task_status(&id, &status, result.as_deref(), completed_at.as_deref())
            .map_err(napi_err)?
            .map(|t| row_json(&t)))
    }

    // ---- dispatch contexts ----

    #[napi(catch_unwind)]
    pub fn create_dispatch_context(&self, task_id: String, assignee_handle: String, id: String, assignee_pane_key: Option<String>, run_id: Option<String>) -> napi::Result<String> {
        self.store()?
            .create_dispatch_context(&task_id, &assignee_handle, &id, assignee_pane_key.as_deref(), run_id.as_deref())
            .map(|d| row_json(&d))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_dispatch_context(&self, task_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_dispatch_context(&task_id).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn get_dispatch_context_by_id(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.dispatch_context_by_id(&id).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn get_active_dispatch_for_terminal(&self, handle: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_active_dispatch_for_terminal(&handle).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn get_latest_dispatch_for_terminal(&self, handle: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_latest_dispatch_for_terminal(&handle).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn complete_dispatch(&self, id: String) -> napi::Result<()> {
        self.store()?.complete_dispatch(&id).map(|_| ()).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn complete_active_dispatch_for_task(&self, task_id: String) -> napi::Result<()> {
        self.store()?.complete_active_dispatch_for_task(&task_id).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn fail_active_dispatch_for_task(&self, task_id: String, error: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.fail_active_dispatch_for_task(&task_id, &error).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn fail_dispatch(&self, id: String, error: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.fail_dispatch(&id, &error).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn record_heartbeat(&self, id: String, at: String) -> napi::Result<()> {
        self.store()?.record_heartbeat(&id, &at).map(|_| ()).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_stale_dispatches(&self, threshold_iso: String) -> napi::Result<String> {
        self.store()?.get_stale_dispatches(&threshold_iso).map(|d| row_json(&d)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn set_dispatch_timestamps(&self, id: String, dispatched_at: Option<String>, last_heartbeat_at: Option<String>) -> napi::Result<()> {
        self.store()?
            .set_dispatch_timestamps(&id, dispatched_at.as_deref(), last_heartbeat_at.as_deref())
            .map(|_| ())
            .map_err(napi_err)
    }

    // ---- dispatch capabilities (v10) ----

    /// Mints the `dcap_` token INSIDE the store (OS CSPRNG), persists only its
    /// SHA-256 + the pane/incarnation binding, and returns the plaintext ONCE.
    #[napi(catch_unwind)]
    pub fn mint_dispatch_capability(
        &self,
        dispatch_id: String,
        pane_key: String,
        process_incarnation: String,
    ) -> napi::Result<String> {
        let params = MintCapabilityParams { dispatch_id, pane_key, process_incarnation };
        self.store()?.mint_dispatch_capability(&params).map_err(napi_err)
    }

    /// Verdict JSON: `{"valid":true}` or `{"valid":false,"reason":…}` — absence
    /// of any presented field is a verdict, never a throw.
    #[napi(catch_unwind)]
    pub fn verify_dispatch_capability(
        &self,
        dispatch_id: String,
        capability: Option<String>,
        pane_key: Option<String>,
        process_incarnation: Option<String>,
    ) -> napi::Result<String> {
        let identity = DispatchIdentity { dispatch_id, capability, pane_key, process_incarnation };
        self.store()?.verify_dispatch_capability(&identity).map(|v| row_json(&v)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn revoke_dispatch_capability(&self, dispatch_id: String) -> napi::Result<()> {
        self.store()?.revoke_dispatch_capability(&dispatch_id).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn commit_dispatch_launch_token_hash(
        &self,
        dispatch_id: String,
        launch_token_hash: String,
    ) -> napi::Result<String> {
        self.store()?
            .commit_dispatch_launch_token_hash(&dispatch_id, &launch_token_hash)
            .map(|d| row_json(&d))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn is_dispatch_process_current(
        &self,
        dispatch_id: String,
        pane_key: Option<String>,
        process_incarnation: Option<String>,
    ) -> napi::Result<bool> {
        let identity =
            DispatchIdentity { dispatch_id, capability: None, pane_key, process_incarnation };
        self.store()?.is_dispatch_process_current(&identity).map_err(napi_err)
    }

    // ---- decision gates ----

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_gate(
        &self,
        id: String,
        task_id: String,
        question: String,
        options: Vec<String>,
        origin_message_id: Option<String>,
        run_id: Option<String>,
        category: Option<String>,
        default_option: Option<String>,
        manager_deadline_at: Option<String>,
        hard_deadline_at: Option<String>,
        policy_snapshot: Option<String>,
    ) -> napi::Result<String> {
        let options: Vec<&str> = options.iter().map(String::as_str).collect();
        let policy = NewGatePolicy { run_id, category, default_option, manager_deadline_at, hard_deadline_at, policy_snapshot };
        self.store()?
            .create_gate(&id, &task_id, &question, &options, origin_message_id.as_deref(), &policy)
            .map(|g| row_json(&g))
            .map_err(napi_err)
    }

    /// CAS gate resolution (schema v9) — returns the tagged outcome JSON, never throws
    /// on a lost race, so a loser can read the winner's committed row.
    #[napi(catch_unwind)]
    pub fn resolve_pending_gate(
        &self,
        id: String,
        expected_version: f64,
        resolution: String,
        resolved_by: String,
        resolution_reason: Option<String>,
        resolved_at: String,
    ) -> napi::Result<String> {
        self.store()?
            .resolve_pending_gate(&id, expected_version as i64, &resolution, &resolved_by, resolution_reason.as_deref(), &resolved_at)
            .map(|o| row_json(&o))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn park_dispatch_waiting_gate(&self, task_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.park_dispatch_waiting_gate(&task_id).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn list_dispatches_waiting_gate(&self) -> napi::Result<String> {
        self.store()?.list_dispatches_waiting_gate().map(|d| row_json(&d)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_pending_gate_for_task(&self, task_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.pending_gate_for_task(&task_id).map_err(napi_err)?.map(|g| row_json(&g)))
    }

    #[napi(catch_unwind)]
    pub fn resolve_gate(&self, id: String, resolution: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.resolve_gate(&id, &resolution).map_err(napi_err)?.map(|g| row_json(&g)))
    }

    #[napi(catch_unwind)]
    pub fn timeout_gate(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.timeout_gate(&id).map_err(napi_err)?.map(|g| row_json(&g)))
    }

    #[napi(catch_unwind)]
    pub fn list_gates(&self, task_id: Option<String>, status: Option<String>, run_id: Option<String>) -> napi::Result<String> {
        self.store()?
            .list_gates(task_id.as_deref(), status.as_deref(), run_id.as_deref())
            .map(|g| row_json(&g))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_gate(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.gate_by_id(&id).map_err(napi_err)?.map(|g| row_json(&g)))
    }

    // ---- coordinator runs ----

    #[napi(catch_unwind)]
    pub fn create_coordinator_run(
        &self,
        id: String,
        spec: String,
        coordinator_handle: String,
        poll_interval_ms: Option<f64>,
        gate_resolution_policy: Option<String>,
        gate_category_allowlist: Option<String>,
    ) -> napi::Result<String> {
        self.store()?
            .create_coordinator_run(
                &id,
                &spec,
                &coordinator_handle,
                poll_interval_ms.map(|n| n as i64),
                gate_resolution_policy.as_deref(),
                gate_category_allowlist.as_deref(),
            )
            .map(|r| row_json(&r))
            .map_err(napi_err)
    }

    /// Bounded run history, newest first (schema v9) — a real LIMIT/OFFSET query.
    #[napi(catch_unwind)]
    pub fn list_coordinator_runs(&self, limit: f64, offset: f64) -> napi::Result<String> {
        self.store()?.list_coordinator_runs(limit as i64, offset as i64).map(|r| row_json(&r)).map_err(napi_err)
    }

    // ---- audit ledger (v9) ----

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn append_audit_event(
        &self,
        id: String,
        run_id: Option<String>,
        actor: String,
        action: String,
        target_pane_key: Option<String>,
        target_handle: Option<String>,
        evidence_ref: Option<String>,
        detail: Option<String>,
    ) -> napi::Result<String> {
        let event = NewAuditEvent { id, run_id, actor, action, target_pane_key, target_handle, evidence_ref, detail };
        self.store()?.append_audit_event(&event).map(|e| row_json(&e)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn list_audit_events(&self, run_id: Option<String>, limit: f64, offset: f64) -> napi::Result<String> {
        self.store()?
            .list_audit_events(run_id.as_deref(), limit as i64, offset as i64)
            .map(|e| row_json(&e))
            .map_err(napi_err)
    }

    // ---- rotation-saga reservations (v9) ----

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn claim_rotation_reservation(
        &self,
        id: String,
        provider: String,
        target_route_key: String,
        target_store_key: Option<String>,
        source_route_key: Option<String>,
        expires_at: String,
        now: String,
    ) -> napi::Result<String> {
        let request = NewRotationReservation { id, provider, source_route_key, target_route_key, target_store_key, expires_at, now };
        self.store()?.claim_rotation_reservation(&request).map(|c| row_json(&c)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn release_rotation_reservation(&self, id: String, fence: f64, now: String) -> napi::Result<bool> {
        self.store()?.release_rotation_reservation(&id, fence as i64, &now).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn renew_rotation_reservation(&self, id: String, fence: f64, expires_at: String, now: String) -> napi::Result<bool> {
        self.store()?.renew_rotation_reservation(&id, fence as i64, &expires_at, &now).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn advance_rotation_saga_phase(
        &self,
        id: String,
        fence: f64,
        phase: String,
        last_error: Option<String>,
        now: String,
    ) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .advance_rotation_saga_phase(&id, fence as i64, &phase, last_error.as_deref(), &now)
            .map_err(napi_err)?
            .map(|s| row_json(&s)))
    }

    #[napi(catch_unwind)]
    pub fn get_rotation_saga(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.rotation_saga_by_id(&id).map_err(napi_err)?.map(|s| row_json(&s)))
    }

    #[napi(catch_unwind)]
    pub fn list_live_rotation_sagas(&self, provider: Option<String>) -> napi::Result<String> {
        self.store()?.list_live_rotation_sagas(provider.as_deref()).map(|s| row_json(&s)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_coordinator_run(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.coordinator_run_by_id(&id).map_err(napi_err)?.map(|r| row_json(&r)))
    }

    #[napi(catch_unwind)]
    pub fn update_coordinator_run(&self, id: String, status: String, completed_at: Option<String>) -> napi::Result<Option<String>> {
        Ok(self.store()?.update_coordinator_run(&id, &status, completed_at.as_deref()).map_err(napi_err)?.map(|r| row_json(&r)))
    }

    #[napi(catch_unwind)]
    pub fn get_active_coordinator_run(&self) -> napi::Result<Option<String>> {
        Ok(self.store()?.active_coordinator_run().map_err(napi_err)?.map(|r| row_json(&r)))
    }

    #[napi(catch_unwind)]
    pub fn get_active_coordinator_runs(&self) -> napi::Result<String> {
        self.store()?.active_coordinator_runs().map(|r| row_json(&r)).map_err(napi_err)
    }

    // ---- queries + lifecycle ----

    #[napi(catch_unwind)]
    pub fn get_idle_terminals(&self, exclude_handles: Vec<String>) -> napi::Result<String> {
        let refs: Vec<&str> = exclude_handles.iter().map(String::as_str).collect();
        self.store()?.get_idle_terminals(&refs).map(|h| row_json(&h)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn reset_all(&self) -> napi::Result<()> {
        self.store()?.reset_all().map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn reset_tasks(&self) -> napi::Result<()> {
        self.store()?.reset_tasks().map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn reset_messages(&self) -> napi::Result<()> {
        self.store()?.reset_messages().map_err(napi_err)
    }

    /// Raw all-tables dump (real ids/timestamps) for the parity state harness.
    #[napi(catch_unwind)]
    pub fn dump_tables_json(&self) -> napi::Result<String> {
        self.store()?.dump_all_rows().map(|v| v.to_string()).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn close(&mut self) {
        self.inner = None;
    }
}
