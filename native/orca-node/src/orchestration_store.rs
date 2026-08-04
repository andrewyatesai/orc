//! `OrchestrationStore` — the Node-API surface of `orca_runtime`'s multi-agent
//! orchestration store, which the main-process `OrchestrationDb` shim in
//! `src/main/runtime/orchestration/db.ts` delegates to (the node:sqlite twin was
//! deleted). JS-side nondeterminism (generated ids, ISO completion stamps,
//! display strings) is passed IN by the shim; every other timestamp uses SQLite
//! `datetime('now')` — byte-identical to what the deleted TS store wrote.
//!
//! ## Marshalling contract
//!
//! * **Rows and composed results** cross as JSON strings (`row_json`); the row
//!   structs serialize to the exact TS Row shape, so the shim only has to
//!   `JSON.parse` and apply its `expose*Timestamps` rewrites.
//! * **Nullable single-row reads** cross as `Option<String>` → `string | null`.
//! * **Argument style** follows one rule, so it can be audited against db.ts
//!   line by line: *a method whose db.ts counterpart takes a params **object**
//!   takes one `paramsJson` string whose keys are exactly that object's
//!   camelCase keys; a method whose db.ts counterpart takes positional scalars
//!   keeps positional scalars.* That puts JSON precisely where argument-order
//!   bugs live. A positional `unknown[]` (effects) travels as a JSON-array
//!   string.
//! * **Coded errors.** `OrchestrationError` already travels inside
//!   `StoreError::Message` as a JSON envelope carrying `_orcaOrchestrationError:
//!   true`, `code`, `message` and `data` (see `orchestration/error.rs`), and
//!   `napi_err` puts that envelope in the JS `Error.message` verbatim — so the
//!   shim parses `error.message` and rethrows an `OrchestrationError` with the
//!   code intact. Nothing here re-wraps or reformats it.

use napi_derive::napi;
use serde_json::Value;

use orca_runtime::orchestration::{
    BindRunParams, CommitLegacyPrincipalParams, CreateQuestionParams,
    CreateRemoteAttachmentParams, CreateStartingWorkerParams, DispatchIdentity, EnqueueRelayParams,
    FederatedWorkerStartReport, ImportRelayItemParams, ImportedRelayLifecycle,
    ImportedRelayMessage, LegacyCoordinatorAuthority, LegacyIdentityQuery, LegacyLifecycle,
    LegacyOperationKey, LegacyOperationMessage, LegacyQuestionQuery, LegacyWorkerCompletionQuery,
    MintCapabilityParams, MutationReceiptKey, NewRunMessage, OrchestrationDb,
    PrepareRemoteAttachmentAuthorityParams, PrepareWorkerAuthorityParams,
    RemoteAttachmentIdentity, RemoteAttachmentStageUpdate, RunDeliveryRequest,
    WorkerFederationTarget, WorkerStageUpdate, DELIVERY_CONTRACT_CURRENT, LEGACY_RUN_ID,
};

// ---------------------------------------------------------------------------
// marshalling helpers
// ---------------------------------------------------------------------------

fn napi_err<E: std::fmt::Display>(err: E) -> napi::Error {
    napi::Error::from_reason(err.to_string())
}

fn row_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// Parse a `paramsJson` argument. A non-object is a shim bug, not a user error,
/// so it fails loudly instead of silently defaulting every field.
fn params_object(raw: &str) -> napi::Result<Value> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| napi::Error::from_reason(format!("invalid params JSON: {error}")))?;
    if !value.is_object() {
        return Err(napi::Error::from_reason("params JSON must be an object"));
    }
    Ok(value)
}

/// A required string field. Missing/null fails loudly rather than writing `""`
/// into a NOT NULL column, which would silently corrupt a row.
fn req_str(value: &Value, key: &str) -> napi::Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| napi::Error::from_reason(format!("params.{key} must be a string")))
}

fn opt_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn str_or(value: &Value, key: &str, fallback: &str) -> String {
    opt_str(value, key).unwrap_or_else(|| fallback.to_string())
}

fn req_i64(value: &Value, key: &str) -> napi::Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| napi::Error::from_reason(format!("params.{key} must be a number")))
}

fn opt_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn opt_str_vec(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key).and_then(Value::as_array).map(|items| {
        items.iter().filter_map(Value::as_str).map(str::to_string).collect()
    })
}

fn str_vec(value: &Value, key: &str) -> Vec<String> {
    opt_str_vec(value, key).unwrap_or_default()
}

fn opt_json_vec(value: &Value, key: &str) -> Option<Vec<Value>> {
    value.get(key).and_then(Value::as_array).cloned()
}

fn json_vec(value: &Value, key: &str) -> Vec<Value> {
    opt_json_vec(value, key).unwrap_or_default()
}

/// A nested object field (JSON `null` reads as absent).
fn sub_object<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|nested| nested.is_object())
}

fn req_sub_object<'a>(value: &'a Value, key: &str) -> napi::Result<&'a Value> {
    sub_object(value, key)
        .ok_or_else(|| napi::Error::from_reason(format!("params.{key} must be an object")))
}

/// Bind values for the raw-SQL test seam: a JSON array, anything else rejected.
fn raw_binds(raw: &str) -> napi::Result<Vec<Value>> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => Ok(items),
        _ => Err(napi::Error::from_reason("raw SQL params must be a JSON array")),
    }
}

/// A standalone `unknown[]` argument (the positional `effects` lists) arrives as
/// a JSON-array string; anything that is not an array reads as empty.
fn effects_from_json(raw: Option<&str>) -> Option<Vec<Value>> {
    let raw = raw?;
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => Some(items),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// nested params builders (one per orca-runtime params type)
// ---------------------------------------------------------------------------

fn mutation_receipt_key(value: &Value) -> napi::Result<MutationReceiptKey> {
    Ok(MutationReceiptKey {
        caller_fingerprint: req_str(value, "callerFingerprint")?,
        request_id: req_str(value, "requestId")?,
        method: req_str(value, "method")?,
        payload_hash: req_str(value, "payloadHash")?,
    })
}

fn legacy_operation_key(value: &Value) -> napi::Result<LegacyOperationKey> {
    Ok(LegacyOperationKey {
        principal_id: req_str(value, "principalId")?,
        operation_key: req_str(value, "operationKey")?,
        method: req_str(value, "method")?,
        payload_hash: req_str(value, "payloadHash")?,
    })
}

fn legacy_identity_query(value: &Value) -> LegacyIdentityQuery {
    LegacyIdentityQuery {
        run_id: opt_str(value, "runId"),
        role: opt_str(value, "role"),
        terminal_handle: opt_str(value, "terminalHandle"),
        pane_key: opt_str(value, "paneKey"),
        dispatch_id: opt_str(value, "dispatchId"),
        task_id: opt_str(value, "taskId"),
    }
}

/// `commitLegacyLifecycleOperation`'s nested `message`. Note the TS keys are
/// `to`/`type`, not `toHandle`/`messageType`.
fn legacy_operation_message(value: &Value) -> napi::Result<LegacyOperationMessage> {
    Ok(LegacyOperationMessage {
        existing_id: opt_str(value, "existingId"),
        to: req_str(value, "to")?,
        subject: req_str(value, "subject")?,
        body: str_or(value, "body", ""),
        message_type: req_str(value, "type")?,
        priority: str_or(value, "priority", "normal"),
        payload: opt_str(value, "payload"),
    })
}

/// The `{ kind }`-tagged lifecycle union `commitLegacyLifecycleOperation` takes.
fn legacy_lifecycle(value: &Value) -> napi::Result<LegacyLifecycle> {
    match req_str(value, "kind")?.as_str() {
        "message_only" => Ok(LegacyLifecycle::MessageOnly),
        "heartbeat" => Ok(LegacyLifecycle::Heartbeat { at: req_str(value, "at")? }),
        "worker_report" => Ok(LegacyLifecycle::WorkerReport {
            task_id: req_str(value, "taskId")?,
            outcome: req_str(value, "outcome")?,
            result: req_str(value, "result")?,
        }),
        other => Err(napi::Error::from_reason(format!("unknown lifecycle kind {other}"))),
    }
}

/// The `{ kind }`-tagged lifecycle union `importFederatedRelayItem` takes — a
/// different set from [`legacy_lifecycle`] (`none` instead of `message_only`,
/// plus `rejected`).
fn imported_relay_lifecycle(value: &Value) -> napi::Result<ImportedRelayLifecycle> {
    match req_str(value, "kind")?.as_str() {
        "none" => Ok(ImportedRelayLifecycle::None),
        "heartbeat" => Ok(ImportedRelayLifecycle::Heartbeat { at: req_str(value, "at")? }),
        "worker_report" => Ok(ImportedRelayLifecycle::WorkerReport {
            task_id: req_str(value, "taskId")?,
            outcome: req_str(value, "outcome")?,
            result: req_str(value, "result")?,
        }),
        "rejected" => Ok(ImportedRelayLifecycle::Rejected {
            code: req_str(value, "code")?,
            reason: req_str(value, "reason")?,
        }),
        other => Err(napi::Error::from_reason(format!("unknown lifecycle kind {other}"))),
    }
}

/// The already-imported relay message. TS keys are `from`/`to`/`type`.
fn imported_relay_message(value: &Value) -> napi::Result<ImportedRelayMessage> {
    Ok(ImportedRelayMessage {
        id: req_str(value, "id")?,
        run_id: req_str(value, "runId")?,
        from_handle: req_str(value, "from")?,
        to_handle: req_str(value, "to")?,
        subject: req_str(value, "subject")?,
        body: str_or(value, "body", ""),
        message_type: req_str(value, "type")?,
        priority: str_or(value, "priority", "normal"),
        thread_id: opt_str(value, "threadId"),
        payload: opt_str(value, "payload"),
    })
}

fn dispatch_identity(value: &Value) -> napi::Result<DispatchIdentity> {
    Ok(DispatchIdentity {
        dispatch_id: req_str(value, "dispatchId")?,
        capability: opt_str(value, "capability"),
        pane_key: opt_str(value, "paneKey"),
        process_incarnation: opt_str(value, "processIncarnation"),
    })
}

fn remote_attachment_identity(value: &Value) -> napi::Result<RemoteAttachmentIdentity> {
    Ok(RemoteAttachmentIdentity {
        dispatch_id: req_str(value, "dispatchId")?,
        capability: opt_str(value, "capability"),
        pane_key: opt_str(value, "paneKey"),
        process_incarnation: opt_str(value, "processIncarnation"),
    })
}

fn worker_federation_target(value: &Value) -> napi::Result<WorkerFederationTarget> {
    Ok(WorkerFederationTarget {
        environment_id: req_str(value, "environmentId")?,
        environment_name: req_str(value, "environmentName")?,
        peer_fingerprint: req_str(value, "peerFingerprint")?,
        protocol_version: req_i64(value, "protocolVersion")?,
    })
}

fn legacy_coordinator_authority(value: &Value) -> napi::Result<LegacyCoordinatorAuthority> {
    Ok(LegacyCoordinatorAuthority {
        run_id: req_str(value, "runId")?,
        principal_id: opt_str(value, "principalId"),
        terminal_handle: req_str(value, "terminalHandle")?,
        pane_key: req_str(value, "paneKey")?,
        consumer_generation: req_i64(value, "consumerGeneration")?,
    })
}

fn legacy_question_query(value: &Value) -> napi::Result<LegacyQuestionQuery> {
    Ok(LegacyQuestionQuery {
        principal_id: req_str(value, "principalId")?,
        question: req_str(value, "question")?,
        options: str_vec(value, "options"),
        recipient_handle: req_str(value, "recipientHandle")?,
    })
}

// ---------------------------------------------------------------------------
// the class
// ---------------------------------------------------------------------------

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

// Every export carries catch_unwind: a Rust panic unwinding across the extern-C
// napi boundary aborts the whole Electron-main process; catch_unwind converts it
// into a JS exception the caller can contain.
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

    /// TS `insertMessage` in full: `{ id, from, to, subject, body?, type?,
    /// priority?, threadId?, payload?, senderPaneKey?, recipientPaneKey?,
    /// runId?, deliveryContract? }`. `id` is the shim's `msg_<hex>` (the TS
    /// `msg.id ?? generateId('msg')` is the shim's job).
    #[napi(catch_unwind)]
    pub fn insert_run_message(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let message = NewRunMessage {
            id: req_str(&params, "id")?,
            run_id: str_or(&params, "runId", LEGACY_RUN_ID),
            delivery_contract: str_or(&params, "deliveryContract", DELIVERY_CONTRACT_CURRENT),
            from_handle: req_str(&params, "from")?,
            to_handle: req_str(&params, "to")?,
            subject: req_str(&params, "subject")?,
            body: str_or(&params, "body", ""),
            message_type: str_or(&params, "type", "status"),
            priority: str_or(&params, "priority", "normal"),
            thread_id: opt_str(&params, "threadId"),
            payload: opt_str(&params, "payload"),
            sender_pane_key: opt_str(&params, "senderPaneKey"),
            recipient_pane_key: opt_str(&params, "recipientPaneKey"),
        };
        self.store()?.insert_run_message(&message).map(|m| row_json(&m)).map_err(napi_err)
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

    #[napi(catch_unwind)]
    pub fn convert_lifecycle_message_to_rejection(&self, message_id: String, code: String, reason: String) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .convert_lifecycle_message_to_rejection(&message_id, &code, &reason)
            .map_err(napi_err)?
            .map(|m| row_json(&m)))
    }

    #[napi(catch_unwind)]
    pub fn mark_as_delivered(&self, ids: Vec<String>) -> napi::Result<()> {
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        self.store()?.mark_as_delivered(&refs).map_err(napi_err)
    }

    // ---- runs ----

    /// TS `createRun` plus the shim's `run_<hex>` id:
    /// `{ id, objective, coordinatorHandle, coordinatorPaneKey }`.
    #[napi(catch_unwind)]
    pub fn create_run(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .create_run(
                &req_str(&params, "id")?,
                &req_str(&params, "objective")?,
                &req_str(&params, "coordinatorHandle")?,
                &req_str(&params, "coordinatorPaneKey")?,
            )
            .map(|r| row_json(&r))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_run(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_run(&id).map_err(napi_err)?.map(|r| row_json(&r)))
    }

    /// TS `listRuns({ limit?, cursor? })` → `{ runs, nextCursor }`. `cursor` is
    /// fully opaque: it encodes the RAW SQLite `created_at` the keyset binds, so
    /// the shim must hand it back unmodified and never rebuild one from an
    /// already-RFC3339-exposed timestamp.
    #[napi(catch_unwind)]
    pub fn list_runs(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .list_runs(opt_i64(&params, "limit"), opt_str(&params, "cursor").as_deref())
            .map(|page| row_json(&page))
            .map_err(napi_err)
    }

    /// TS `bindRun({ runId, coordinatorHandle, coordinatorPaneKey,
    /// takeoverLegacy?, legacyCoordinatorAuthority? })`.
    #[napi(catch_unwind)]
    pub fn bind_run(&self, params_json: String) -> napi::Result<Option<String>> {
        let params = params_object(&params_json)?;
        let authority = match sub_object(&params, "legacyCoordinatorAuthority") {
            Some(nested) => Some(legacy_coordinator_authority(nested)?),
            None => None,
        };
        let bind = BindRunParams {
            run_id: req_str(&params, "runId")?,
            coordinator_handle: req_str(&params, "coordinatorHandle")?,
            coordinator_pane_key: req_str(&params, "coordinatorPaneKey")?,
            takeover_legacy: flag(&params, "takeoverLegacy"),
            legacy_coordinator_authority: authority,
        };
        Ok(self.store()?.bind_run(&bind).map_err(napi_err)?.map(|r| row_json(&r)))
    }

    #[napi(catch_unwind)]
    pub fn get_current_run_for_pane(&self, pane_key: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_current_run_for_pane(&pane_key).map_err(napi_err)?.map(|r| row_json(&r)))
    }

    /// TS `getOrCreateRunDelivery({ runId, consumerGeneration, limit?,
    /// wakeTypes? })` plus the shim's `delivery_<hex>` id, which is consumed
    /// only when this call actually cuts a new delivery.
    #[napi(catch_unwind)]
    pub fn get_or_create_run_delivery(&self, params_json: String) -> napi::Result<Option<String>> {
        let params = params_object(&params_json)?;
        let request = RunDeliveryRequest {
            run_id: req_str(&params, "runId")?,
            consumer_generation: req_i64(&params, "consumerGeneration")?,
            delivery_id: req_str(&params, "deliveryId")?,
            limit: opt_i64(&params, "limit"),
            wake_types: opt_str_vec(&params, "wakeTypes"),
        };
        Ok(self
            .store()?
            .get_or_create_run_delivery(&request)
            .map_err(napi_err)?
            .map(|delivery| row_json(&delivery)))
    }

    /// TS `acknowledgeRunDelivery({ runId, consumerGeneration, deliveryId })`.
    #[napi(catch_unwind)]
    pub fn acknowledge_run_delivery(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .acknowledge_run_delivery(
                &req_str(&params, "runId")?,
                req_i64(&params, "consumerGeneration")?,
                &req_str(&params, "deliveryId")?,
            )
            .map(|ack| row_json(&ack))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn has_pending_current_delivery(&self, run_id: String) -> napi::Result<bool> {
        self.store()?.has_pending_current_delivery(&run_id).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_run_mailbox_history(&self, run_id: String, limit: f64, types: Option<Vec<String>>) -> napi::Result<String> {
        self.store()?
            .get_run_mailbox_history(&run_id, limit as i64, types.as_deref())
            .map(|m| row_json(&m))
            .map_err(napi_err)
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

    /// TS `listTasks({ status?, ready?, runId? })` — the shim maps `ready: true`
    /// to `status = 'ready'`.
    #[napi(catch_unwind)]
    pub fn list_tasks(&self, status: Option<String>, run_id: Option<String>) -> napi::Result<String> {
        self.store()?
            .list_tasks(status.as_deref(), run_id.as_deref())
            .map(|t| row_json(&t))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn list_tasks_with_dispatch(&self, status: Option<String>, run_id: Option<String>) -> napi::Result<String> {
        self.store()?
            .list_tasks_with_dispatch(status.as_deref(), run_id.as_deref())
            .map(|t| row_json(&t))
            .map_err(napi_err)
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
    pub fn create_dispatch_context(
        &self,
        task_id: String,
        assignee_handle: String,
        id: String,
        assignee_pane_key: Option<String>,
        launch_token_hash: Option<String>,
    ) -> napi::Result<String> {
        self.store()?
            .create_dispatch_context(&task_id, &assignee_handle, &id, assignee_pane_key.as_deref(), launch_token_hash.as_deref())
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

    /// TS `getActiveDispatchForIdentity` — pane-aware assignee lookup.
    #[napi(catch_unwind)]
    pub fn get_active_dispatch_for_identity(&self, handle: String, pane_key: Option<String>) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .get_active_dispatch_for_identity(&handle, pane_key.as_deref())
            .map_err(napi_err)?
            .map(|d| row_json(&d)))
    }

    #[napi(catch_unwind)]
    pub fn get_latest_dispatch_for_terminal(&self, handle: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_latest_dispatch_for_terminal(&handle).map_err(napi_err)?.map(|d| row_json(&d)))
    }

    /// TS `hasAnyDispatchContexts` — the raw probe. The TS twin memoises it on
    /// the store instance and invalidates on reset; that memo stays shim-side.
    #[napi(catch_unwind)]
    pub fn has_any_dispatch_contexts(&self) -> napi::Result<bool> {
        self.store()?.has_any_dispatch_contexts().map_err(napi_err)
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

    // ---- dispatch capabilities ----

    /// TS `mintDispatchCapability({ dispatchId, paneKey, processIncarnation })`.
    /// RETURNS the freshly minted `dcap_<base64url>` plaintext — the store owns
    /// the CSPRNG, hands the token back exactly once, and persists only its hash.
    #[napi(catch_unwind)]
    pub fn mint_dispatch_capability(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let mint = MintCapabilityParams {
            dispatch_id: req_str(&params, "dispatchId")?,
            pane_key: req_str(&params, "paneKey")?,
            process_incarnation: req_str(&params, "processIncarnation")?,
        };
        self.store()?.mint_dispatch_capability(&mint).map_err(napi_err)
    }

    /// TS `verifyDispatchCapability({ dispatchId, capability, paneKey,
    /// processIncarnation })` → `{ valid: true } | { valid: false, reason }`.
    #[napi(catch_unwind)]
    pub fn verify_dispatch_capability(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let identity = dispatch_identity(&params)?;
        self.store()?.verify_dispatch_capability(&identity).map(|v| row_json(&v)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn revoke_dispatch_capability(&self, dispatch_id: String) -> napi::Result<()> {
        self.store()?.revoke_dispatch_capability(&dispatch_id).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn commit_dispatch_launch_token_hash(&self, dispatch_id: String, launch_token_hash: String) -> napi::Result<String> {
        self.store()?
            .commit_dispatch_launch_token_hash(&dispatch_id, &launch_token_hash)
            .map(|d| row_json(&d))
            .map_err(napi_err)
    }

    /// TS `isDispatchProcessCurrent({ dispatchId, paneKey, processIncarnation })`.
    #[napi(catch_unwind)]
    pub fn is_dispatch_process_current(&self, params_json: String) -> napi::Result<bool> {
        let params = params_object(&params_json)?;
        let identity = dispatch_identity(&params)?;
        self.store()?.is_dispatch_process_current(&identity).map_err(napi_err)
    }

    // ---- questions ----

    /// TS `createQuestion({ runId, dispatchId, askerHandle, question, options? })`
    /// plus the shim's `msg_<hex>` `messageId` for the question message — which
    /// the store also stamps as the thread id.
    #[napi(catch_unwind)]
    pub fn create_question(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let create = CreateQuestionParams {
            message_id: req_str(&params, "messageId")?,
            run_id: req_str(&params, "runId")?,
            dispatch_id: req_str(&params, "dispatchId")?,
            asker_handle: req_str(&params, "askerHandle")?,
            question: req_str(&params, "question")?,
            options: str_vec(&params, "options"),
        };
        self.store()?.create_question(&create).map(|t| row_json(&t)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_question(&self, message_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_question(&message_id).map_err(napi_err)?.map(|q| row_json(&q)))
    }

    /// TS `answerQuestion({ messageId, runId, consumerGeneration, body })` plus
    /// the shim's `msg_<hex>` `answerMessageId` for the reply it inserts.
    #[napi(catch_unwind)]
    pub fn answer_question(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .answer_question(
                &req_str(&params, "messageId")?,
                &req_str(&params, "runId")?,
                req_i64(&params, "consumerGeneration")?,
                &req_str(&params, "answerMessageId")?,
                &req_str(&params, "body")?,
            )
            .map(|a| row_json(&a))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn close_questions_for_dispatch(&self, dispatch_id: String) -> napi::Result<Vec<String>> {
        self.store()?.close_questions_for_dispatch(&dispatch_id).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_remote_question(&self, message_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_remote_question(&message_id).map_err(napi_err)?.map(|q| row_json(&q)))
    }

    /// TS `answerRemoteQuestion({ messageId, dispatchId, answerMessageId, body })`.
    #[napi(catch_unwind)]
    pub fn answer_remote_question(&self, params_json: String) -> napi::Result<()> {
        let params = params_object(&params_json)?;
        self.store()?
            .answer_remote_question(
                &req_str(&params, "messageId")?,
                &req_str(&params, "dispatchId")?,
                &req_str(&params, "answerMessageId")?,
                &req_str(&params, "body")?,
            )
            .map_err(napi_err)
    }

    /// TS `registerFederatedQuestion({ messageId, runId, dispatchId })`.
    /// `messageId` is the already-imported relay message's id, never a fresh one.
    #[napi(catch_unwind)]
    pub fn register_federated_question(&self, params_json: String) -> napi::Result<()> {
        let params = params_object(&params_json)?;
        self.store()?
            .register_federated_question(
                &req_str(&params, "messageId")?,
                &req_str(&params, "runId")?,
                &req_str(&params, "dispatchId")?,
            )
            .map_err(napi_err)
    }

    /// TS `findLegacyQuestionsBySemanticIdentity({ principalId, question,
    /// options?, recipientHandle })`.
    #[napi(catch_unwind)]
    pub fn find_legacy_questions_by_semantic_identity(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let query = legacy_question_query(&params)?;
        self.store()?
            .find_legacy_questions_by_semantic_identity(&query)
            .map(|m| row_json(&m))
            .map_err(napi_err)
    }

    /// TS `findPendingLegacyQuestions` — same query object, pending only.
    #[napi(catch_unwind)]
    pub fn find_pending_legacy_questions(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let query = legacy_question_query(&params)?;
        self.store()?.find_pending_legacy_questions(&query).map(|q| row_json(&q)).map_err(napi_err)
    }

    // ---- worker dispatches ----

    /// TS `createStartingWorkerDispatch({ taskId, startOptions, launchTokenHash?,
    /// retryOf?, runtimeEpoch?, federation?, mutationReceipt? })` plus the shim's
    /// `ctx_<hex>` `dispatchId`. `startOptions` is the ALREADY-`JSON.stringify`d
    /// text, matching what the TS twin writes to the column.
    #[napi(catch_unwind)]
    pub fn create_starting_worker_dispatch(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let federation = match sub_object(&params, "federation") {
            Some(nested) => Some(worker_federation_target(nested)?),
            None => None,
        };
        let mutation_receipt = match sub_object(&params, "mutationReceipt") {
            Some(nested) => Some(mutation_receipt_key(nested)?),
            None => None,
        };
        let create = CreateStartingWorkerParams {
            dispatch_id: req_str(&params, "dispatchId")?,
            task_id: req_str(&params, "taskId")?,
            start_options: req_str(&params, "startOptions")?,
            launch_token_hash: opt_str(&params, "launchTokenHash"),
            retry_of: opt_str(&params, "retryOf"),
            runtime_epoch: opt_str(&params, "runtimeEpoch"),
            federation,
            mutation_receipt,
        };
        self.store()?.create_starting_worker_dispatch(&create).map(|s| row_json(&s)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_worker_dispatch(&self, dispatch_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_worker_dispatch(&dispatch_id).map_err(napi_err)?.map(|w| row_json(&w)))
    }

    /// `effectsJson` is a JSON array string (TS `effects?: unknown[]`); omitting
    /// it keeps the already-recorded effects.
    #[napi(catch_unwind)]
    pub fn mark_worker_dispatch_ready(&self, dispatch_id: String, effects_json: Option<String>) -> napi::Result<String> {
        let effects = effects_from_json(effects_json.as_deref());
        self.store()?
            .mark_worker_dispatch_ready(&dispatch_id, effects.as_deref())
            .map(|w| row_json(&w))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn mark_worker_start_unknown(&self, dispatch_id: String, stage: String, reason: String) -> napi::Result<String> {
        self.store()?
            .mark_worker_start_unknown(&dispatch_id, &stage, &reason)
            .map(|w| row_json(&w))
            .map_err(napi_err)
    }

    /// Deliberate divergence from the TS twin: an unknown dispatch id raises the
    /// coded `dispatch_not_found` error instead of returning `undefined` (which
    /// every caller then dereferenced). The shim must let it propagate.
    #[napi(catch_unwind)]
    pub fn mark_worker_stop_unknown(&self, dispatch_id: String, reason: String) -> napi::Result<String> {
        self.store()?.mark_worker_stop_unknown(&dispatch_id, &reason).map(|w| row_json(&w)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn fail_worker_start(&self, dispatch_id: String, stage: String, reason: String) -> napi::Result<String> {
        self.store()?.fail_worker_start(&dispatch_id, &stage, &reason).map(|w| row_json(&w)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn begin_worker_stop(&self, dispatch_id: String) -> napi::Result<String> {
        self.store()?.begin_worker_stop(&dispatch_id).map(|s| row_json(&s)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn settle_worker_stop(&self, dispatch_id: String) -> napi::Result<String> {
        self.store()?.settle_worker_stop(&dispatch_id).map(|w| row_json(&w)).map_err(napi_err)
    }

    /// TS `settleWorkerReport({ taskId, dispatchId, outcome, result })` →
    /// the `{ action: 'settled' | 'rejected', … }` union.
    #[napi(catch_unwind)]
    pub fn settle_worker_report(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .settle_worker_report(
                &req_str(&params, "taskId")?,
                &req_str(&params, "dispatchId")?,
                &req_str(&params, "outcome")?,
                &req_str(&params, "result")?,
            )
            .map(|s| row_json(&s))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn abandon_worker_dispatch(&self, dispatch_id: String) -> napi::Result<String> {
        self.store()?.abandon_worker_dispatch(&dispatch_id).map(|a| row_json(&a)).map_err(napi_err)
    }

    /// TS `recordWorkerStage({ dispatchId, stage, worktreeId?, terminalHandle?,
    /// setupState?, effects?, residualResources?, lastError?, state? })` — an
    /// absent field leaves the column untouched.
    #[napi(catch_unwind)]
    pub fn record_worker_stage(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let update = WorkerStageUpdate {
            dispatch_id: req_str(&params, "dispatchId")?,
            stage: req_str(&params, "stage")?,
            worktree_id: opt_str(&params, "worktreeId"),
            terminal_handle: opt_str(&params, "terminalHandle"),
            setup_state: opt_str(&params, "setupState"),
            effects: opt_json_vec(&params, "effects"),
            residual_resources: opt_json_vec(&params, "residualResources"),
            last_error: opt_str(&params, "lastError"),
            state: opt_str(&params, "state"),
        };
        self.store()?.record_worker_stage(&update).map(|w| row_json(&w)).map_err(napi_err)
    }

    /// TS `updateWorkerSetupEvidence({ dispatchId, setupState, effects })`.
    #[napi(catch_unwind)]
    pub fn update_worker_setup_evidence(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .update_worker_setup_evidence(
                &req_str(&params, "dispatchId")?,
                &req_str(&params, "setupState")?,
                &json_vec(&params, "effects"),
            )
            .map(|e| row_json(&e))
            .map_err(napi_err)
    }

    /// TS `prepareStartingWorkerAuthority({ dispatchId, handle, paneKey,
    /// processIncarnation, launchTokenHash?, worktreeId, effects, setupState })`.
    /// RETURNS the freshly minted `dcap_<base64url>` plaintext — hand it to the
    /// launcher once and never persist it.
    #[napi(catch_unwind)]
    pub fn prepare_starting_worker_authority(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let prepare = PrepareWorkerAuthorityParams {
            dispatch_id: req_str(&params, "dispatchId")?,
            handle: req_str(&params, "handle")?,
            pane_key: req_str(&params, "paneKey")?,
            process_incarnation: req_str(&params, "processIncarnation")?,
            launch_token_hash: opt_str(&params, "launchTokenHash"),
            worktree_id: req_str(&params, "worktreeId")?,
            effects: json_vec(&params, "effects"),
            setup_state: req_str(&params, "setupState")?,
        };
        self.store()?.prepare_starting_worker_authority(&prepare).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn reconcile_missing_worker_terminal(&self, dispatch_id: String, reason: String) -> napi::Result<String> {
        self.store()?
            .reconcile_missing_worker_terminal(&dispatch_id, &reason)
            .map(|w| row_json(&w))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn list_legacy_worker_terminal_recovery_rows(&self) -> napi::Result<String> {
        self.store()?.list_legacy_worker_terminal_recovery_rows().map(|r| row_json(&r)).map_err(napi_err)
    }

    // ---- federation ----

    #[napi(catch_unwind)]
    pub fn get_federated_dispatch(&self, dispatch_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_federated_dispatch(&dispatch_id).map_err(napi_err)?.map(|f| row_json(&f)))
    }

    #[napi(catch_unwind)]
    pub fn list_active_federated_dispatches(&self, run_id: Option<String>) -> napi::Result<String> {
        self.store()?
            .list_active_federated_dispatches(run_id.as_deref())
            .map(|f| row_json(&f))
            .map_err(napi_err)
    }

    /// TS `updateFederatedDispatchResources({ dispatchId, remoteRuntimeEpoch,
    /// worktreeId, terminalHandle })`.
    #[napi(catch_unwind)]
    pub fn update_federated_dispatch_resources(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .update_federated_dispatch_resources(
                &req_str(&params, "dispatchId")?,
                &req_str(&params, "remoteRuntimeEpoch")?,
                &req_str(&params, "worktreeId")?,
                &req_str(&params, "terminalHandle")?,
            )
            .map(|f| row_json(&f))
            .map_err(napi_err)
    }

    /// TS `reconcileFederatedWorkerStart({ dispatchId, state, stage, lastError?,
    /// worktreeId?, terminalHandle?, setupState?, effects?, residualResources? })`.
    #[napi(catch_unwind)]
    pub fn reconcile_federated_worker_start(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let report = FederatedWorkerStartReport {
            dispatch_id: req_str(&params, "dispatchId")?,
            state: req_str(&params, "state")?,
            stage: req_str(&params, "stage")?,
            last_error: opt_str(&params, "lastError"),
            worktree_id: opt_str(&params, "worktreeId"),
            terminal_handle: opt_str(&params, "terminalHandle"),
            setup_state: opt_str(&params, "setupState"),
            effects: opt_json_vec(&params, "effects"),
            residual_resources: opt_json_vec(&params, "residualResources"),
        };
        self.store()?.reconcile_federated_worker_start(&report).map(|w| row_json(&w)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn reconcile_federated_worker_stop(&self, dispatch_id: String) -> napi::Result<String> {
        self.store()?.reconcile_federated_worker_stop(&dispatch_id).map(|w| row_json(&w)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn resume_federated_worker_for_terminal_relay(&self, dispatch_id: String) -> napi::Result<String> {
        self.store()?
            .resume_federated_worker_for_terminal_relay(&dispatch_id)
            .map(|w| row_json(&w))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn set_federated_home_import_sequence(&self, dispatch_id: String, sequence: f64) -> napi::Result<()> {
        self.store()?.set_federated_home_import_sequence(&dispatch_id, sequence as i64).map_err(napi_err)
    }

    /// TS `enqueueFederationRelay({ dispatchId, direction, kind, payload,
    /// messageId?, settleRemoteOutcome?, remoteQuestion? })`. Leave `messageId`
    /// absent and the STORE mints the `relay_<hex>` — do not pre-generate one.
    #[napi(catch_unwind)]
    pub fn enqueue_federation_relay(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let enqueue = EnqueueRelayParams {
            dispatch_id: req_str(&params, "dispatchId")?,
            direction: req_str(&params, "direction")?,
            kind: req_str(&params, "kind")?,
            payload: req_str(&params, "payload")?,
            message_id: opt_str(&params, "messageId"),
            settle_remote_outcome: opt_str(&params, "settleRemoteOutcome"),
            remote_question: flag(&params, "remoteQuestion"),
        };
        self.store()?.enqueue_federation_relay(&enqueue).map(|i| row_json(&i)).map_err(napi_err)
    }

    /// TS `listFederationRelay({ dispatchId, direction, afterSequence, limit? })`.
    #[napi(catch_unwind)]
    pub fn list_federation_relay(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .list_federation_relay(
                &req_str(&params, "dispatchId")?,
                &req_str(&params, "direction")?,
                req_i64(&params, "afterSequence")?,
                opt_i64(&params, "limit"),
            )
            .map(|i| row_json(&i))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn list_pending_federation_relay(&self, dispatch_id: String, direction: String, limit: f64) -> napi::Result<String> {
        self.store()?
            .list_pending_federation_relay(&dispatch_id, &direction, limit as i64)
            .map(|i| row_json(&i))
            .map_err(napi_err)
    }

    /// TS `acknowledgeFederationRelay({ dispatchId, direction, throughSequence })`.
    #[napi(catch_unwind)]
    pub fn acknowledge_federation_relay(&self, params_json: String) -> napi::Result<()> {
        let params = params_object(&params_json)?;
        self.store()?
            .acknowledge_federation_relay(
                &req_str(&params, "dispatchId")?,
                &req_str(&params, "direction")?,
                req_i64(&params, "throughSequence")?,
            )
            .map_err(napi_err)
    }

    /// TS `importFederatedRelayItem({ dispatchId, sequence, message, lifecycle })`.
    /// `message` uses the wire keys `{ id, runId, from, to, subject, body, type,
    /// priority, threadId?, payload? }`; `lifecycle` is the `{ kind }` union
    /// `none | heartbeat | worker_report | rejected`.
    #[napi(catch_unwind)]
    pub fn import_federated_relay_item(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let import = ImportRelayItemParams {
            dispatch_id: req_str(&params, "dispatchId")?,
            sequence: req_i64(&params, "sequence")?,
            message: imported_relay_message(req_sub_object(&params, "message")?)?,
            lifecycle: imported_relay_lifecycle(req_sub_object(&params, "lifecycle")?)?,
        };
        self.store()?.import_federated_relay_item(&import).map(|i| row_json(&i)).map_err(napi_err)
    }

    // ---- remote dispatch attachments (the worker side of federation) ----

    /// TS `createRemoteDispatchAttachment({ dispatchId, taskId,
    /// homePeerFingerprint, protocolVersion, runtimeEpoch, mutationReceipt })`.
    #[napi(catch_unwind)]
    pub fn create_remote_dispatch_attachment(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let create = CreateRemoteAttachmentParams {
            dispatch_id: req_str(&params, "dispatchId")?,
            task_id: req_str(&params, "taskId")?,
            home_peer_fingerprint: req_str(&params, "homePeerFingerprint")?,
            protocol_version: req_i64(&params, "protocolVersion")?,
            runtime_epoch: req_str(&params, "runtimeEpoch")?,
            mutation_receipt: mutation_receipt_key(req_sub_object(&params, "mutationReceipt")?)?,
        };
        self.store()?.create_remote_dispatch_attachment(&create).map(|a| row_json(&a)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_remote_dispatch_attachment(&self, dispatch_id: String) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .get_remote_dispatch_attachment(&dispatch_id)
            .map_err(napi_err)?
            .map(|a| row_json(&a)))
    }

    #[napi(catch_unwind)]
    pub fn find_active_remote_attachment_for_pane(&self, pane_key: String) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .find_active_remote_attachment_for_pane(&pane_key)
            .map_err(napi_err)?
            .map(|a| row_json(&a)))
    }

    /// `effectsJson` is a JSON array string (TS `effects?: unknown[]`).
    #[napi(catch_unwind)]
    pub fn mark_remote_attachment_ready(&self, dispatch_id: String, effects_json: Option<String>) -> napi::Result<String> {
        let effects = effects_from_json(effects_json.as_deref());
        self.store()?
            .mark_remote_attachment_ready(&dispatch_id, effects.as_deref())
            .map(|a| row_json(&a))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn mark_remote_attachment_stop_unknown(&self, dispatch_id: String, reason: String) -> napi::Result<String> {
        self.store()?
            .mark_remote_attachment_stop_unknown(&dispatch_id, &reason)
            .map(|a| row_json(&a))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn begin_remote_attachment_stop(&self, dispatch_id: String) -> napi::Result<String> {
        self.store()?.begin_remote_attachment_stop(&dispatch_id).map(|a| row_json(&a)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn settle_remote_attachment_stop(&self, dispatch_id: String) -> napi::Result<String> {
        self.store()?.settle_remote_attachment_stop(&dispatch_id).map(|a| row_json(&a)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn fail_remote_attachment(&self, dispatch_id: String, stage: String, reason: String, unknown: bool) -> napi::Result<String> {
        self.store()?
            .fail_remote_attachment(&dispatch_id, &stage, &reason, unknown)
            .map(|a| row_json(&a))
            .map_err(napi_err)
    }

    /// TS `recordRemoteAttachmentStage({ dispatchId, stage, state?, worktreeId?,
    /// terminalHandle?, setupState?, effects?, residualResources?, lastError? })`.
    #[napi(catch_unwind)]
    pub fn record_remote_attachment_stage(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let update = RemoteAttachmentStageUpdate {
            dispatch_id: req_str(&params, "dispatchId")?,
            stage: req_str(&params, "stage")?,
            state: opt_str(&params, "state"),
            worktree_id: opt_str(&params, "worktreeId"),
            terminal_handle: opt_str(&params, "terminalHandle"),
            setup_state: opt_str(&params, "setupState"),
            effects: opt_json_vec(&params, "effects"),
            residual_resources: opt_json_vec(&params, "residualResources"),
            last_error: opt_str(&params, "lastError"),
        };
        self.store()?.record_remote_attachment_stage(&update).map(|a| row_json(&a)).map_err(napi_err)
    }

    /// TS `updateRemoteAttachmentSetupEvidence({ dispatchId, setupState, effects })`.
    #[napi(catch_unwind)]
    pub fn update_remote_attachment_setup_evidence(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .update_remote_attachment_setup_evidence(
                &req_str(&params, "dispatchId")?,
                &req_str(&params, "setupState")?,
                &json_vec(&params, "effects"),
            )
            .map(|e| row_json(&e))
            .map_err(napi_err)
    }

    /// TS `prepareRemoteAttachmentAuthority({ dispatchId, paneKey,
    /// processIncarnation, worktreeId, terminalHandle, setupState, effects })`.
    /// RETURNS the freshly minted `dcap_<base64url>` plaintext.
    #[napi(catch_unwind)]
    pub fn prepare_remote_attachment_authority(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let prepare = PrepareRemoteAttachmentAuthorityParams {
            dispatch_id: req_str(&params, "dispatchId")?,
            pane_key: req_str(&params, "paneKey")?,
            process_incarnation: req_str(&params, "processIncarnation")?,
            worktree_id: req_str(&params, "worktreeId")?,
            terminal_handle: req_str(&params, "terminalHandle")?,
            setup_state: req_str(&params, "setupState")?,
            effects: json_vec(&params, "effects"),
        };
        self.store()?.prepare_remote_attachment_authority(&prepare).map_err(napi_err)
    }

    /// TS `verifyRemoteAttachmentAuthority({ dispatchId, capability, paneKey,
    /// processIncarnation })`.
    #[napi(catch_unwind)]
    pub fn verify_remote_attachment_authority(&self, params_json: String) -> napi::Result<bool> {
        let params = params_object(&params_json)?;
        let identity = remote_attachment_identity(&params)?;
        self.store()?.verify_remote_attachment_authority(&identity).map_err(napi_err)
    }

    /// TS `isRemoteAttachmentProcessCurrent({ dispatchId, paneKey,
    /// processIncarnation })`.
    #[napi(catch_unwind)]
    pub fn is_remote_attachment_process_current(&self, params_json: String) -> napi::Result<bool> {
        let params = params_object(&params_json)?;
        let identity = remote_attachment_identity(&params)?;
        self.store()?.is_remote_attachment_process_current(&identity).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn set_remote_worker_import_sequence(&self, dispatch_id: String, sequence: f64) -> napi::Result<()> {
        self.store()?.set_remote_worker_import_sequence(&dispatch_id, sequence as i64).map_err(napi_err)
    }

    // ---- mutation receipts ----

    /// TS `beginMutationReceipt({ callerFingerprint, requestId, method,
    /// payloadHash })` → `{ disposition, row }`.
    #[napi(catch_unwind)]
    pub fn begin_mutation_receipt(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let key = mutation_receipt_key(&params)?;
        self.store()?.begin_mutation_receipt(&key).map(|claim| row_json(&claim)).map_err(napi_err)
    }

    /// TS `completeMutationReceipt({ callerFingerprint, requestId, method,
    /// payloadHash, receipt })`.
    #[napi(catch_unwind)]
    pub fn complete_mutation_receipt(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let key = mutation_receipt_key(&params)?;
        self.store()?
            .complete_mutation_receipt(&key, &req_str(&params, "receipt")?)
            .map(|r| row_json(&r))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn discard_pending_mutation_receipt(&self, caller_fingerprint: String, request_id: String) -> napi::Result<()> {
        self.store()?
            .discard_pending_mutation_receipt(&caller_fingerprint, &request_id)
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_mutation_receipt(&self, caller_fingerprint: String, request_id: String) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .get_mutation_receipt(&caller_fingerprint, &request_id)
            .map_err(napi_err)?
            .map(|r| row_json(&r)))
    }

    // ---- legacy compatibility ----

    #[napi(catch_unwind)]
    pub fn get_legacy_adoption(&self) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_legacy_adoption().map_err(napi_err)?.map(|a| row_json(&a)))
    }

    /// TS `commitLegacyCompatibilityPrincipal({ runId, dispatchId?, role,
    /// hostScope, terminalHandle, paneKey, launchTokenHash, processIncarnation? })`
    /// plus the shim's `legacy_principal_<hex>` `id`.
    #[napi(catch_unwind)]
    pub fn commit_legacy_compatibility_principal(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let commit = CommitLegacyPrincipalParams {
            id: req_str(&params, "id")?,
            run_id: req_str(&params, "runId")?,
            dispatch_id: opt_str(&params, "dispatchId"),
            role: req_str(&params, "role")?,
            host_scope: req_str(&params, "hostScope")?,
            terminal_handle: req_str(&params, "terminalHandle")?,
            pane_key: req_str(&params, "paneKey")?,
            launch_token_hash: req_str(&params, "launchTokenHash")?,
            process_incarnation: opt_str(&params, "processIncarnation"),
        };
        self.store()?
            .commit_legacy_compatibility_principal(&commit)
            .map(|c| row_json(&c))
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_legacy_compatibility_principal(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_legacy_compatibility_principal(&id).map_err(napi_err)?.map(|p| row_json(&p)))
    }

    #[napi(catch_unwind)]
    pub fn list_legacy_compatibility_principals(&self, run_id: String) -> napi::Result<String> {
        self.store()?.list_legacy_compatibility_principals(&run_id).map(|p| row_json(&p)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_legacy_coordinator_principal(&self, run_id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.get_legacy_coordinator_principal(&run_id).map_err(napi_err)?.map(|p| row_json(&p)))
    }

    #[napi(catch_unwind)]
    pub fn set_legacy_compatibility_principal_status(&self, id: String, status: String) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .set_legacy_compatibility_principal_status(&id, &status)
            .map_err(napi_err)?
            .map(|p| row_json(&p)))
    }

    #[napi(catch_unwind)]
    pub fn is_legacy_coordinator_handle(&self, run_id: String, terminal_handle: String) -> napi::Result<bool> {
        self.store()?.is_legacy_coordinator_handle(&run_id, &terminal_handle).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_legacy_operation_receipt(&self, principal_id: String, operation_key: String) -> napi::Result<Option<String>> {
        Ok(self
            .store()?
            .get_legacy_operation_receipt(&principal_id, &operation_key)
            .map_err(napi_err)?
            .map(|r| row_json(&r)))
    }

    /// TS `resolveLegacyCompatibilityPrincipalByIdentity({ runId, role,
    /// terminalHandle?, paneKey? })`.
    #[napi(catch_unwind)]
    pub fn resolve_legacy_compatibility_principal_by_identity(&self, params_json: String) -> napi::Result<Option<String>> {
        let params = params_object(&params_json)?;
        let query = legacy_identity_query(&params);
        Ok(self
            .store()?
            .resolve_legacy_compatibility_principal_by_identity(&query)
            .map_err(napi_err)?
            .map(|p| row_json(&p)))
    }

    /// TS `resolveLegacyCoordinatorCandidate({ runId, terminalHandle?, paneKey? })`
    /// → `{ terminalHandle, paneKey }`.
    #[napi(catch_unwind)]
    pub fn resolve_legacy_coordinator_candidate(&self, params_json: String) -> napi::Result<Option<String>> {
        let params = params_object(&params_json)?;
        let query = legacy_identity_query(&params);
        Ok(self
            .store()?
            .resolve_legacy_coordinator_candidate(&query)
            .map_err(napi_err)?
            .map(|c| row_json(&c)))
    }

    /// TS `resolveLegacyWorkerCandidate({ runId?, terminalHandle?, paneKey?,
    /// dispatchId?, taskId? })`. Deliberate shape divergence: this returns the
    /// bare `DispatchContextRow` JSON, while TS returns `{ dispatch }` — the
    /// shim wraps it. That will NOT show up as a compile error.
    #[napi(catch_unwind)]
    pub fn resolve_legacy_worker_candidate(&self, params_json: String) -> napi::Result<Option<String>> {
        let params = params_object(&params_json)?;
        let query = legacy_identity_query(&params);
        Ok(self
            .store()?
            .resolve_legacy_worker_candidate(&query)
            .map_err(napi_err)?
            .map(|d| row_json(&d)))
    }

    /// TS `findLegacyWorkerCompletion({ principalId, taskId, recipientHandle,
    /// subject, body, payload })`.
    #[napi(catch_unwind)]
    pub fn find_legacy_worker_completion(&self, params_json: String) -> napi::Result<Option<String>> {
        let params = params_object(&params_json)?;
        let query = LegacyWorkerCompletionQuery {
            principal_id: req_str(&params, "principalId")?,
            task_id: req_str(&params, "taskId")?,
            recipient_handle: req_str(&params, "recipientHandle")?,
            subject: req_str(&params, "subject")?,
            body: str_or(&params, "body", ""),
            payload: opt_str(&params, "payload"),
        };
        Ok(self.store()?.find_legacy_worker_completion(&query).map_err(napi_err)?.map(|m| row_json(&m)))
    }

    /// TS `getLegacyMailPage({ principalId, limit?, types? })`.
    #[napi(catch_unwind)]
    pub fn get_legacy_mail_page(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .get_legacy_mail_page(
                &req_str(&params, "principalId")?,
                opt_i64(&params, "limit"),
                opt_str_vec(&params, "types").as_deref(),
            )
            .map(|page| row_json(&page))
            .map_err(napi_err)
    }

    /// TS `getLegacyMailHistory({ principalId, limit?, types? })`.
    #[napi(catch_unwind)]
    pub fn get_legacy_mail_history(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .get_legacy_mail_history(
                &req_str(&params, "principalId")?,
                opt_i64(&params, "limit"),
                opt_str_vec(&params, "types").as_deref(),
            )
            .map(|page| row_json(&page))
            .map_err(napi_err)
    }

    /// TS `acknowledgeLegacyMail({ principalId, messageIds, types? })`.
    #[napi(catch_unwind)]
    pub fn acknowledge_legacy_mail(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let message_ids = str_vec(&params, "messageIds");
        let refs: Vec<&str> = message_ids.iter().map(String::as_str).collect();
        self.store()?
            .acknowledge_legacy_mail(
                &req_str(&params, "principalId")?,
                &refs,
                opt_str_vec(&params, "types").as_deref(),
            )
            .map(|ack| row_json(&ack))
            .map_err(napi_err)
    }

    /// TS `acknowledgeLegacyQuestionAnswer({ principalId, questionId,
    /// answerMessageId })`.
    #[napi(catch_unwind)]
    pub fn acknowledge_legacy_question_answer(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        self.store()?
            .acknowledge_legacy_question_answer(
                &req_str(&params, "principalId")?,
                &req_str(&params, "questionId")?,
                &req_str(&params, "answerMessageId")?,
            )
            .map(|ack| row_json(&ack))
            .map_err(napi_err)
    }

    /// TS `commitLegacyLifecycleOperation({ principalId, operationKey, method,
    /// payloadHash, message, lifecycle })`. The store mints the `msg_<hex>` for
    /// the message it writes (from SQLite randomblob) — pass `message.existingId`
    /// only on a retry that already minted one.
    #[napi(catch_unwind)]
    pub fn commit_legacy_lifecycle_operation(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let key = legacy_operation_key(&params)?;
        let message = legacy_operation_message(req_sub_object(&params, "message")?)?;
        let lifecycle = legacy_lifecycle(req_sub_object(&params, "lifecycle")?)?;
        self.store()?
            .commit_legacy_lifecycle_operation(&key, &message, &lifecycle)
            .map(|commit| row_json(&commit))
            .map_err(napi_err)
    }

    /// TS `commitLegacyAskOperation({ principalId, operationKey, method,
    /// payloadHash, question, options?, recipientHandle, existingQuestionId? })`.
    #[napi(catch_unwind)]
    pub fn commit_legacy_ask_operation(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let key = legacy_operation_key(&params)?;
        self.store()?
            .commit_legacy_ask_operation(
                &key,
                &req_str(&params, "question")?,
                &str_vec(&params, "options"),
                &req_str(&params, "recipientHandle")?,
                opt_str(&params, "existingQuestionId").as_deref(),
            )
            .map(|commit| row_json(&commit))
            .map_err(napi_err)
    }

    /// TS `commitLegacyReplyOperation({ principalId, operationKey, method,
    /// payloadHash, questionId, body })`.
    #[napi(catch_unwind)]
    pub fn commit_legacy_reply_operation(&self, params_json: String) -> napi::Result<String> {
        let params = params_object(&params_json)?;
        let key = legacy_operation_key(&params)?;
        self.store()?
            .commit_legacy_reply_operation(&key, &req_str(&params, "questionId")?, &req_str(&params, "body")?)
            .map(|commit| row_json(&commit))
            .map_err(napi_err)
    }

    // ---- decision gates ----

    #[napi(catch_unwind)]
    pub fn create_gate(
        &self,
        id: String,
        task_id: String,
        question: String,
        options: Vec<String>,
        origin_message_id: Option<String>,
    ) -> napi::Result<String> {
        let options: Vec<&str> = options.iter().map(String::as_str).collect();
        self.store()?
            .create_gate(&id, &task_id, &question, &options, origin_message_id.as_deref())
            .map(|g| row_json(&g))
            .map_err(napi_err)
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
    pub fn list_gates(&self, task_id: Option<String>, status: Option<String>) -> napi::Result<String> {
        self.store()?.list_gates(task_id.as_deref(), status.as_deref()).map(|g| row_json(&g)).map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn get_gate(&self, id: String) -> napi::Result<Option<String>> {
        Ok(self.store()?.gate_by_id(&id).map_err(napi_err)?.map(|g| row_json(&g)))
    }

    // ---- coordinator runs ----

    #[napi(catch_unwind)]
    pub fn create_coordinator_run(&self, id: String, spec: String, coordinator_handle: String, poll_interval_ms: Option<f64>) -> napi::Result<String> {
        self.store()?
            .create_coordinator_run(&id, &spec, &coordinator_handle, poll_interval_ms.map(|n| n as i64))
            .map(|r| row_json(&r))
            .map_err(napi_err)
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

    /// Raw-SQL introspection seam for fork specs and tooling — never production.
    /// `params_json` is a JSON array of bind values; an empty array runs `sql`
    /// as a multi-statement batch.
    #[napi(catch_unwind)]
    pub fn raw_exec(&self, sql: String, params_json: String) -> napi::Result<()> {
        self.store()?.raw_exec(&sql, &raw_binds(&params_json)?).map_err(napi_err)
    }

    /// Rows of `sql` as a JSON array of column-keyed objects. Tests only.
    #[napi(catch_unwind)]
    pub fn raw_query_json(&self, sql: String, params_json: String) -> napi::Result<String> {
        self.store()?
            .raw_query(&sql, &raw_binds(&params_json)?)
            .map(|rows| rows.to_string())
            .map_err(napi_err)
    }

    #[napi(catch_unwind)]
    pub fn close(&mut self) {
        self.inner = None;
    }
}
