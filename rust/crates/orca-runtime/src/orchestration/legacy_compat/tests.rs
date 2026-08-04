use super::*;

const ADOPTED: &str = "run_adopted";
const COORD: &str = "coordinator";
const WORKER: &str = "worker-a";
const WORKER_PANE: &str = "tab1:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
const WORKER_PANE_REMINTED: &str = "tab9:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
const COORD_PANE: &str = "tab1:1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d";

fn error_code(error: &StoreError) -> String {
    let StoreError::Message(text) = error else {
        panic!("expected a message error, got {error:?}");
    };
    let parsed: serde_json::Value = serde_json::from_str(text).expect("coded error JSON");
    parsed["code"].as_str().unwrap().to_string()
}

fn error_data(error: &StoreError) -> serde_json::Value {
    let StoreError::Message(text) = error else {
        panic!("expected a message error, got {error:?}");
    };
    let parsed: serde_json::Value = serde_json::from_str(text).expect("coded error JSON");
    parsed["data"].clone()
}

/// A store whose legacy Run has already been adopted onto [`ADOPTED`].
fn adopted_store() -> OrchestrationDb {
    let db = OrchestrationDb::open_in_memory().unwrap();
    db.connection()
        .execute(
            "INSERT INTO runs (id, objective, consumer_generation, legacy) VALUES (?1, 'adopted', 0, 0)",
            [ADOPTED],
        )
        .unwrap();
    db.connection()
        .execute(
            "INSERT INTO legacy_adoptions (source_run_id, adopted_run_id, scheduler_state_lost)
             VALUES (?1, ?2, 1)",
            params![LEGACY_RUN_ID, ADOPTED],
        )
        .unwrap();
    db
}

fn seed_task(db: &OrchestrationDb, id: &str, status: &str, creator: Option<&str>) {
    db.connection()
        .execute(
            "INSERT INTO tasks (id, run_id, created_by_terminal_handle, spec, status, deps)
             VALUES (?1, ?2, ?3, 'spec', ?4, '[]')",
            params![id, ADOPTED, creator, status],
        )
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
fn seed_dispatch(
    db: &OrchestrationDb,
    id: &str,
    task_id: &str,
    handle: &str,
    pane_key: Option<&str>,
    status: &str,
    contract_version: i64,
) {
    db.connection()
        .execute(
            "INSERT INTO dispatch_contexts (
               id, run_id, task_id, contract_version, assignee_handle, assignee_pane_key, status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, ADOPTED, task_id, contract_version, handle, pane_key, status],
        )
        .unwrap();
}

/// A pending legacy dispatch on a dispatched task, created by [`COORD`].
fn seed_legacy_attempt(db: &OrchestrationDb, task_id: &str, dispatch_id: &str) {
    seed_task(db, task_id, "dispatched", Some(COORD));
    seed_dispatch(db, dispatch_id, task_id, WORKER, Some(WORKER_PANE), "dispatched", 0);
}

#[allow(clippy::too_many_arguments)]
fn seed_message(
    db: &OrchestrationDb,
    id: &str,
    contract: &str,
    from: &str,
    to: &str,
    message_type: &str,
    read: i64,
) {
    db.connection()
        .execute(
            "INSERT INTO messages (
               id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, read
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'subject', 'body', ?6, ?7)",
            params![id, ADOPTED, contract, from, to, message_type, read],
        )
        .unwrap();
}

fn worker_params(dispatch_id: &str) -> CommitLegacyPrincipalParams {
    CommitLegacyPrincipalParams {
        id: "legacy_principal_w".to_string(),
        run_id: ADOPTED.to_string(),
        dispatch_id: Some(dispatch_id.to_string()),
        role: LEGACY_ROLE_WORKER.to_string(),
        host_scope: "local".to_string(),
        terminal_handle: WORKER.to_string(),
        pane_key: WORKER_PANE.to_string(),
        launch_token_hash: "hash".to_string(),
        process_incarnation: Some("pid-1".to_string()),
    }
}

fn coordinator_params() -> CommitLegacyPrincipalParams {
    CommitLegacyPrincipalParams {
        id: "legacy_principal_c".to_string(),
        run_id: ADOPTED.to_string(),
        dispatch_id: None,
        role: LEGACY_ROLE_COORDINATOR.to_string(),
        host_scope: "local".to_string(),
        terminal_handle: COORD.to_string(),
        pane_key: COORD_PANE.to_string(),
        launch_token_hash: "hash".to_string(),
        process_incarnation: None,
    }
}

fn key(principal_id: &str, operation_key: &str, method: &str) -> LegacyOperationKey {
    LegacyOperationKey {
        principal_id: principal_id.to_string(),
        operation_key: operation_key.to_string(),
        method: method.to_string(),
        payload_hash: "payload-hash".to_string(),
    }
}

fn status_message(to: &str) -> LegacyOperationMessage {
    LegacyOperationMessage {
        to: to.to_string(),
        subject: "update".to_string(),
        body: "working".to_string(),
        message_type: "status".to_string(),
        priority: "normal".to_string(),
        ..LegacyOperationMessage::default()
    }
}

// ── adoption + principal commit ─────────────────────────────────────────────

#[test]
fn adoption_is_read_by_source_run() {
    let empty = OrchestrationDb::open_in_memory().unwrap();
    assert!(empty.get_legacy_adoption().unwrap().is_none());

    let db = adopted_store();
    let adoption = db.get_legacy_adoption().unwrap().unwrap();
    assert_eq!(adoption.source_run_id, LEGACY_RUN_ID);
    assert_eq!(adoption.adopted_run_id, ADOPTED);
    assert_eq!(adoption.scheduler_state_lost, 1);
}

#[test]
fn commits_a_worker_principal_and_seeds_its_recovery_cohort() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    // Already-read legacy mail this pre-Run worker consumed without a receipt.
    seed_message(&db, "m_read", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 1);
    seed_message(&db, "m_dispatch", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, "dispatch:ctx1", "status", 1);
    // Not the cohort: current_delivery, and mail for another handle.
    seed_message(&db, "m_current", DELIVERY_CONTRACT_CURRENT, COORD, WORKER, "status", 1);
    seed_message(&db, "m_other", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, "worker-b", "status", 1);

    let committed = db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();

    assert!(!committed.duplicate);
    assert_eq!(committed.principal.status, "committed");
    assert_eq!(committed.principal.run_id, ADOPTED);
    assert_eq!(committed.principal.dispatch_id.as_deref(), Some("ctx1"));
    let cohort: Vec<String> = {
        let conn = db.connection();
        let mut stmt = conn
            .prepare("SELECT message_id FROM legacy_mail_receipts WHERE principal_id = ?1 ORDER BY message_id")
            .unwrap();
        let rows = stmt.query_map(["legacy_principal_w"], |row| row.get(0)).unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    };
    assert_eq!(cohort, vec!["m_dispatch".to_string(), "m_read".to_string()]);

    // Replaying identical proof is a duplicate, not a second row.
    let replay = db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    assert!(replay.duplicate);
    assert_eq!(db.list_legacy_compatibility_principals(ADOPTED).unwrap().len(), 1);
}

#[test]
fn worker_principal_of_a_settled_dispatch_commits_as_settled() {
    let db = adopted_store();
    seed_task(&db, "t1", "completed", Some(COORD));
    seed_dispatch(&db, "ctx1", "t1", WORKER, Some(WORKER_PANE), "completed", 0);
    seed_message(&db, "m_read", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 1);

    let committed = db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();

    assert_eq!(committed.principal.status, "settled");
    // A settled principal gets no recovery cohort — it will never poll again.
    let cohort: i64 = db
        .connection()
        .query_row("SELECT COUNT(*) FROM legacy_mail_receipts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(cohort, 0);
}

#[test]
fn principal_commit_rejects_a_foreign_run_dispatch_or_proof() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    // A current-contract dispatch is not a legacy attempt.
    seed_task(&db, "t2", "dispatched", Some(COORD));
    seed_dispatch(&db, "ctx2", "t2", "worker-b", None, "dispatched", 1);

    let wrong_run =
        CommitLegacyPrincipalParams { run_id: "run_other".to_string(), ..worker_params("ctx1") };
    assert_eq!(
        error_code(&db.commit_legacy_compatibility_principal(&wrong_run).unwrap_err()),
        "request_mismatch"
    );
    assert_eq!(
        error_code(&db.commit_legacy_compatibility_principal(&worker_params("ctx2")).unwrap_err()),
        "request_mismatch"
    );
    let missing = CommitLegacyPrincipalParams { dispatch_id: None, ..worker_params("ctx1") };
    assert_eq!(
        error_code(&db.commit_legacy_compatibility_principal(&missing).unwrap_err()),
        "request_mismatch"
    );
    // A coordinator may not name a Dispatch.
    let coordinator_with_dispatch = CommitLegacyPrincipalParams {
        dispatch_id: Some("ctx1".to_string()),
        ..coordinator_params()
    };
    assert_eq!(
        error_code(
            &db.commit_legacy_compatibility_principal(&coordinator_with_dispatch).unwrap_err()
        ),
        "request_mismatch"
    );

    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    // Same (role, run, dispatch) with different proof is a mismatch, not a replay.
    let different_proof = CommitLegacyPrincipalParams {
        launch_token_hash: "other".to_string(),
        ..worker_params("ctx1")
    };
    assert_eq!(
        error_code(&db.commit_legacy_compatibility_principal(&different_proof).unwrap_err()),
        "request_mismatch"
    );
}

#[test]
fn a_revoked_principal_is_read_only() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    db.set_legacy_compatibility_principal_status("legacy_principal_w", "revoked").unwrap();

    let error = db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap_err();
    assert_eq!(error_code(&error), "legacy_read_only");
    assert_eq!(error_data(&error), serde_json::json!({ "effectsApplied": false }));
}

#[test]
fn coordinator_principal_needs_a_provable_seat() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");

    // COORD is the only durable non-worker handle → it can claim the seat.
    let committed = db.commit_legacy_compatibility_principal(&coordinator_params()).unwrap();
    assert_eq!(committed.principal.status, "committed");
    assert_eq!(committed.principal.dispatch_id, None);
    assert_eq!(
        db.get_legacy_coordinator_principal(ADOPTED).unwrap().unwrap().id,
        "legacy_principal_c"
    );

    // Another handle cannot: the seat is taken by a committed principal.
    let intruder = CommitLegacyPrincipalParams {
        id: "legacy_principal_c2".to_string(),
        terminal_handle: "coordinator-2".to_string(),
        ..coordinator_params()
    };
    let error = db.commit_legacy_compatibility_principal(&intruder).unwrap_err();
    // The (role, run, NULL dispatch) row already exists with different proof.
    assert_eq!(error_code(&error), "request_mismatch");
}

#[test]
fn coordinator_principal_without_authority_is_read_only() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    // A current consumer already bound the Run's coordinator pane.
    db.connection()
        .execute(
            "UPDATE runs SET coordinator_handle = 'new-coord', coordinator_pane_key = ?2 WHERE id = ?1",
            params![ADOPTED, COORD_PANE],
        )
        .unwrap();

    let error = db.commit_legacy_compatibility_principal(&coordinator_params()).unwrap_err();
    assert_eq!(error_code(&error), "legacy_read_only");
    assert_eq!(error_data(&error), serde_json::json!({ "effectsApplied": false }));
}

// ── identity resolution ─────────────────────────────────────────────────────

#[test]
fn resolves_a_principal_by_pane_or_handle_and_refuses_ambiguity() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();

    let by_pane = LegacyIdentityQuery {
        run_id: Some(ADOPTED.to_string()),
        role: Some(LEGACY_ROLE_WORKER.to_string()),
        // A reminted tab keeps the same leaf, so it still resolves.
        pane_key: Some(WORKER_PANE_REMINTED.to_string()),
        ..LegacyIdentityQuery::default()
    };
    assert_eq!(
        db.resolve_legacy_compatibility_principal_by_identity(&by_pane).unwrap().unwrap().id,
        "legacy_principal_w"
    );
    let by_handle = LegacyIdentityQuery {
        run_id: Some(ADOPTED.to_string()),
        role: Some(LEGACY_ROLE_WORKER.to_string()),
        terminal_handle: Some(WORKER.to_string()),
        ..LegacyIdentityQuery::default()
    };
    assert!(db.resolve_legacy_compatibility_principal_by_identity(&by_handle).unwrap().is_some());
    // No identity presented at all resolves to nothing.
    let bare = LegacyIdentityQuery {
        run_id: Some(ADOPTED.to_string()),
        role: Some(LEGACY_ROLE_WORKER.to_string()),
        ..LegacyIdentityQuery::default()
    };
    assert!(db.resolve_legacy_compatibility_principal_by_identity(&bare).unwrap().is_none());

    // Two settled principals on the same pane cannot be told apart.
    seed_task(&db, "t2", "dispatched", Some(COORD));
    seed_dispatch(&db, "ctx2", "t2", WORKER, Some(WORKER_PANE), "dispatched", 0);
    db.connection()
        .execute(
            "INSERT INTO legacy_compatibility_principals (
               id, run_id, dispatch_id, role, host_scope, terminal_handle, pane_key,
               launch_token_hash, status
             ) VALUES ('legacy_principal_w2', ?1, 'ctx2', 'worker', 'local', ?2, ?3, 'hash', 'settled')",
            params![ADOPTED, WORKER, WORKER_PANE],
        )
        .unwrap();
    assert_eq!(
        error_code(
            &db.resolve_legacy_compatibility_principal_by_identity(&by_pane).unwrap_err()
        ),
        "operation_unknown"
    );
}

#[test]
fn resolves_a_worker_dispatch_from_a_partial_identity() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");

    let by_handle = LegacyIdentityQuery {
        run_id: Some(ADOPTED.to_string()),
        terminal_handle: Some(WORKER.to_string()),
        ..LegacyIdentityQuery::default()
    };
    assert_eq!(db.resolve_legacy_worker_candidate(&by_handle).unwrap().unwrap().id, "ctx1");
    let by_pane = LegacyIdentityQuery {
        run_id: Some(ADOPTED.to_string()),
        pane_key: Some(WORKER_PANE_REMINTED.to_string()),
        task_id: Some("t1".to_string()),
        ..LegacyIdentityQuery::default()
    };
    assert_eq!(db.resolve_legacy_worker_candidate(&by_pane).unwrap().unwrap().id, "ctx1");
    // The task filter still applies.
    let wrong_task = LegacyIdentityQuery { task_id: Some("t9".to_string()), ..by_pane.clone() };
    assert!(db.resolve_legacy_worker_candidate(&wrong_task).unwrap().is_none());
    // Without a Run, or without any identity, there is no candidate.
    assert!(db
        .resolve_legacy_worker_candidate(&LegacyIdentityQuery {
            run_id: None,
            ..by_handle.clone()
        })
        .unwrap()
        .is_none());

    // A named legacy dispatch this process cannot prove is retained, not absent.
    seed_task(&db, "t2", "dispatched", Some(COORD));
    seed_dispatch(&db, "ctx2", "t2", "worker-b", None, "dispatched", 0);
    let unprovable = LegacyIdentityQuery {
        run_id: Some(ADOPTED.to_string()),
        terminal_handle: Some(WORKER.to_string()),
        dispatch_id: Some("ctx2".to_string()),
        ..LegacyIdentityQuery::default()
    };
    assert_eq!(
        error_code(&db.resolve_legacy_worker_candidate(&unprovable).unwrap_err()),
        "legacy_read_only"
    );

    // Two live legacy dispatches on the same handle are ambiguous.
    seed_task(&db, "t3", "dispatched", Some(COORD));
    seed_dispatch(&db, "ctx3", "t3", WORKER, Some(WORKER_PANE), "dispatched", 0);
    assert_eq!(
        error_code(&db.resolve_legacy_worker_candidate(&by_handle).unwrap_err()),
        "operation_unknown"
    );
}

#[test]
fn resolves_the_coordinator_seat_from_durable_evidence() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");

    let query = LegacyIdentityQuery {
        run_id: Some(ADOPTED.to_string()),
        terminal_handle: Some(COORD.to_string()),
        pane_key: Some(COORD_PANE.to_string()),
        ..LegacyIdentityQuery::default()
    };
    assert_eq!(
        db.resolve_legacy_coordinator_candidate(&query).unwrap().unwrap(),
        LegacyCoordinatorCandidate {
            terminal_handle: COORD.to_string(),
            pane_key: COORD_PANE.to_string(),
        }
    );
    assert!(db.is_legacy_coordinator_handle(ADOPTED, COORD).unwrap());
    assert!(!db.is_legacy_coordinator_handle(ADOPTED, WORKER).unwrap());
    // A partial identity is never a candidate.
    let partial = LegacyIdentityQuery { pane_key: None, ..query.clone() };
    assert!(db.resolve_legacy_coordinator_candidate(&partial).unwrap().is_none());
    // Neither is a different handle.
    let other = LegacyIdentityQuery {
        terminal_handle: Some("coordinator-2".to_string()),
        ..query.clone()
    };
    assert!(db.resolve_legacy_coordinator_candidate(&other).unwrap().is_none());

    // Once a committed principal holds the seat, the handle answer comes from it.
    db.commit_legacy_compatibility_principal(&coordinator_params()).unwrap();
    assert!(db.is_legacy_coordinator_handle(ADOPTED, COORD).unwrap());
    assert!(db.resolve_legacy_coordinator_candidate(&query).unwrap().is_some());
    // …and a revoked one loses it.
    db.set_legacy_compatibility_principal_status("legacy_principal_c", "revoked").unwrap();
    assert!(db.resolve_legacy_coordinator_candidate(&query).unwrap().is_none());
}

// ── mail ────────────────────────────────────────────────────────────────────

#[test]
fn mail_page_replays_the_recovery_cohort_before_live_mail() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    seed_message(&db, "m_read", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 1);
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    seed_message(&db, "m_unread", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "dispatch", 0);

    // The cohort wins while it is unacknowledged.
    let page = db.get_legacy_mail_page("legacy_principal_w", None, None).unwrap();
    assert!(page.recovery);
    assert_eq!(page.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["m_read"]);

    db.acknowledge_legacy_mail("legacy_principal_w", &["m_read"], None).unwrap();
    let page = db.get_legacy_mail_page("legacy_principal_w", None, None).unwrap();
    assert!(!page.recovery);
    assert_eq!(page.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["m_unread"]);
    // The type filter narrows the live page.
    let filtered = db
        .get_legacy_mail_page("legacy_principal_w", None, Some(&["status".to_string()]))
        .unwrap();
    assert!(filtered.messages.is_empty());

    // History is unfiltered by read state and never a recovery page.
    let history = db.get_legacy_mail_history("legacy_principal_w", None, None).unwrap();
    assert!(!history.recovery);
    assert_eq!(
        history.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["m_read", "m_unread"]
    );
    assert_eq!(
        db.get_legacy_mail_history("legacy_principal_w", Some(1), None).unwrap().messages.len(),
        1
    );
    // Mail for an unknown principal is not readable.
    assert_eq!(
        error_code(&db.get_legacy_mail_page("ghost", None, None).unwrap_err()),
        "request_mismatch"
    );
}

#[test]
fn acknowledging_mail_marks_it_read_and_is_idempotent() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    seed_message(&db, "m1", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 0);
    seed_message(&db, "m2", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, "dispatch:ctx1", "status", 0);

    let ack = db.acknowledge_legacy_mail("legacy_principal_w", &["m1", "m2", "m1"], None).unwrap();
    assert!(!ack.duplicate);
    assert_eq!(
        ack.receipts.iter().map(|r| r.message_id.as_str()).collect::<Vec<_>>(),
        vec!["m1", "m2"]
    );
    assert!(ack.receipts.iter().all(|receipt| receipt.acknowledged_at.is_some()));
    let stored = db.get_message_by_id("m1").unwrap().unwrap();
    assert_eq!(stored.read, 1);
    assert!(stored.delivered_at.is_some());

    // Replaying the same page is a duplicate, and keeps the first stamp.
    let first_stamp = ack.receipts[0].acknowledged_at.clone();
    let replay = db.acknowledge_legacy_mail("legacy_principal_w", &["m1", "m2"], None).unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.receipts[0].acknowledged_at, first_stamp);
    // An empty ack is a no-op duplicate.
    assert_eq!(
        db.acknowledge_legacy_mail("legacy_principal_w", &[], None).unwrap(),
        LegacyMailAck { receipts: Vec::new(), duplicate: true }
    );
}

#[test]
fn acknowledging_mail_refuses_a_foreign_inbox_or_a_stale_page() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    seed_message(&db, "m1", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 0);
    seed_message(&db, "m2", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 0);
    seed_message(&db, "m_other", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, "worker-b", "status", 0);

    // m2 is not the head of the replay page, so acknowledging it alone is stale.
    assert_eq!(
        error_code(&db.acknowledge_legacy_mail("legacy_principal_w", &["m2"], None).unwrap_err()),
        "request_mismatch"
    );
    // Another principal's mail is out of this inbox.
    assert_eq!(
        error_code(
            &db.acknowledge_legacy_mail("legacy_principal_w", &["m1", "m_other"], None)
                .unwrap_err()
        ),
        "request_mismatch"
    );
    // Rolled back: nothing was marked read.
    assert_eq!(db.get_message_by_id("m1").unwrap().unwrap().read, 0);
}

#[test]
fn acknowledging_a_question_answer_settles_one_receipt() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    // The legacy ask and its legacy_direct answer.
    seed_message(&db, "q1", DELIVERY_CONTRACT_LEGACY_DIRECT, WORKER, COORD, "decision_gate", 1);
    seed_message(&db, "a1", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 0);
    db.connection()
        .execute(
            "INSERT INTO question_threads (
               message_id, run_id, dispatch_id, asker_handle, status, answer_message_id, answer_body
             ) VALUES ('q1', ?1, 'ctx1', ?2, 'answered', 'a1', 'yes')",
            params![ADOPTED, WORKER],
        )
        .unwrap();

    let ack = db.acknowledge_legacy_question_answer("legacy_principal_w", "q1", "a1").unwrap();
    assert!(!ack.duplicate);
    assert_eq!(ack.receipt.message_id, "a1");
    assert!(ack.receipt.acknowledged_at.is_some());
    assert_eq!(db.get_message_by_id("a1").unwrap().unwrap().read, 1);

    let replay = db.acknowledge_legacy_question_answer("legacy_principal_w", "q1", "a1").unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.receipt.acknowledged_at, ack.receipt.acknowledged_at);

    // A message that is not the thread's recorded answer does not match.
    seed_message(&db, "a2", DELIVERY_CONTRACT_LEGACY_DIRECT, COORD, WORKER, "status", 0);
    assert_eq!(
        error_code(
            &db.acknowledge_legacy_question_answer("legacy_principal_w", "q1", "a2").unwrap_err()
        ),
        "request_mismatch"
    );
    assert_eq!(
        error_code(
            &db.acknowledge_legacy_question_answer("legacy_principal_w", "ghost", "a1")
                .unwrap_err()
        ),
        "request_mismatch"
    );
}

// ── lifecycle operations ────────────────────────────────────────────────────

#[test]
fn lifecycle_commit_sends_mail_and_records_one_receipt() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();

    let commit = db
        .commit_legacy_lifecycle_operation(
            &key("legacy_principal_w", "op1", "orchestration.send"),
            &status_message(COORD),
            &LegacyLifecycle::MessageOnly,
        )
        .unwrap();

    assert!(!commit.duplicate);
    assert!(commit.settlement.is_none());
    // No current consumer holds the seat, so mail stays on the legacy route.
    assert_eq!(commit.message.to_handle, COORD);
    assert_eq!(
        commit.message.delivery_contract.as_deref(),
        Some(DELIVERY_CONTRACT_LEGACY_DIRECT)
    );
    assert_eq!(commit.message.from_handle, WORKER);
    assert_eq!(commit.message.sender_pane_key.as_deref(), Some(WORKER_PANE));
    assert_eq!(commit.message.subject, "update");
    assert!(commit.message.id.starts_with("msg_"));
    assert_eq!(commit.receipt.effect_id, commit.message.id);
    assert_eq!(commit.receipt.method, "orchestration.send");
    assert_eq!(
        commit.receipt.response_json,
        format!(r#"{{"messageId":"{}"}}"#, commit.message.id)
    );
    assert_eq!(
        db.get_legacy_operation_receipt("legacy_principal_w", "op1").unwrap().unwrap(),
        commit.receipt
    );

    // Replay returns the same effect without sending a second message.
    let replay = db
        .commit_legacy_lifecycle_operation(
            &key("legacy_principal_w", "op1", "orchestration.send"),
            &status_message(COORD),
            &LegacyLifecycle::MessageOnly,
        )
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.message.id, commit.message.id);
    let sent: i64 = db
        .connection()
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(sent, 1);

    // The same operation key with different input is refused.
    let mut reused = key("legacy_principal_w", "op1", "orchestration.send");
    reused.payload_hash = "other".to_string();
    assert_eq!(
        error_code(
            &db.commit_legacy_lifecycle_operation(
                &reused,
                &status_message(COORD),
                &LegacyLifecycle::MessageOnly
            )
            .unwrap_err()
        ),
        "request_mismatch"
    );
}

#[test]
fn lifecycle_commit_reroutes_to_the_run_after_a_takeover() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    db.connection()
        .execute(
            "UPDATE runs SET coordinator_handle = 'new-coord', coordinator_pane_key = ?2 WHERE id = ?1",
            params![ADOPTED, COORD_PANE],
        )
        .unwrap();

    let commit = db
        .commit_legacy_lifecycle_operation(
            &key("legacy_principal_w", "op1", "orchestration.send"),
            &status_message(COORD),
            &LegacyLifecycle::MessageOnly,
        )
        .unwrap();

    assert_eq!(commit.message.to_handle, format!("run:{ADOPTED}"));
    assert_eq!(commit.message.delivery_contract.as_deref(), Some(DELIVERY_CONTRACT_CURRENT));
}

#[test]
fn lifecycle_commit_stamps_a_heartbeat_and_settles_a_worker_report() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();

    let mut beat = status_message(COORD);
    beat.message_type = "heartbeat".to_string();
    db.commit_legacy_lifecycle_operation(
        &key("legacy_principal_w", "op_beat", "orchestration.heartbeat"),
        &beat,
        &LegacyLifecycle::Heartbeat { at: "2026-01-02T03:04:05.000Z".to_string() },
    )
    .unwrap();
    assert_eq!(
        db.dispatch_context_by_id("ctx1").unwrap().unwrap().last_heartbeat_at.as_deref(),
        Some("2026-01-02T03:04:05.000Z")
    );

    let mut done = status_message(COORD);
    done.message_type = "worker_done".to_string();
    let commit = db
        .commit_legacy_lifecycle_operation(
            &key("legacy_principal_w", "op_done", "orchestration.worker-done"),
            &done,
            &LegacyLifecycle::WorkerReport {
                task_id: "t1".to_string(),
                outcome: "succeeded".to_string(),
                result: "shipped".to_string(),
            },
        )
        .unwrap();

    assert_eq!(
        commit.settlement,
        Some(WorkerReportSettlement::Settled {
            outcome: "succeeded".to_string(),
            duplicate: false
        })
    );
    assert_eq!(db.get_task("t1").unwrap().unwrap().status, "completed");
    assert_eq!(db.dispatch_context_by_id("ctx1").unwrap().unwrap().status, "completed");
    // The principal settles with its dispatch.
    assert_eq!(
        db.get_legacy_compatibility_principal("legacy_principal_w").unwrap().unwrap().status,
        "settled"
    );
    // The settlement round-trips through the stored receipt on replay.
    let replay = db
        .commit_legacy_lifecycle_operation(
            &key("legacy_principal_w", "op_done", "orchestration.worker-done"),
            &done,
            &LegacyLifecycle::WorkerReport {
                task_id: "t1".to_string(),
                outcome: "succeeded".to_string(),
                result: "shipped".to_string(),
            },
        )
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.settlement, commit.settlement);
}

#[test]
fn lifecycle_commit_refuses_a_settled_dispatch_without_a_reconstruction() {
    let db = adopted_store();
    seed_task(&db, "t1", "completed", Some(COORD));
    seed_dispatch(&db, "ctx1", "t1", WORKER, Some(WORKER_PANE), "completed", 0);
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();

    // A fresh send against a settled dispatch is refused…
    assert_eq!(
        error_code(
            &db.commit_legacy_lifecycle_operation(
                &key("legacy_principal_w", "op1", "orchestration.send"),
                &status_message(COORD),
                &LegacyLifecycle::MessageOnly
            )
            .unwrap_err()
        ),
        "dispatch_inactive"
    );

    // …but reconstructing the completion that was already sent is allowed, and
    // reports the persisted outcome rather than re-settling.
    seed_message(&db, "done1", DELIVERY_CONTRACT_LEGACY_DIRECT, WORKER, COORD, "worker_done", 1);
    let mut done = status_message(COORD);
    done.message_type = "worker_done".to_string();
    done.existing_id = Some("done1".to_string());
    let commit = db
        .commit_legacy_lifecycle_operation(
            &key("legacy_principal_w", "op2", "orchestration.worker-done"),
            &done,
            &LegacyLifecycle::WorkerReport {
                task_id: "t1".to_string(),
                outcome: "succeeded".to_string(),
                result: "shipped".to_string(),
            },
        )
        .unwrap();
    assert_eq!(commit.message.id, "done1");
    assert_eq!(
        commit.settlement,
        Some(WorkerReportSettlement::Settled {
            outcome: "succeeded".to_string(),
            duplicate: true
        })
    );

    // A reconstruction whose message belongs to someone else is a mismatch.
    seed_message(&db, "done2", DELIVERY_CONTRACT_LEGACY_DIRECT, "worker-b", COORD, "worker_done", 1);
    done.existing_id = Some("done2".to_string());
    assert_eq!(
        error_code(
            &db.commit_legacy_lifecycle_operation(
                &key("legacy_principal_w", "op3", "orchestration.worker-done"),
                &done,
                &LegacyLifecycle::WorkerReport {
                    task_id: "t1".to_string(),
                    outcome: "succeeded".to_string(),
                    result: "shipped".to_string(),
                }
            )
            .unwrap_err()
        ),
        "request_mismatch"
    );
}

#[test]
fn lifecycle_commit_requires_a_worker_principal() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&coordinator_params()).unwrap();

    assert_eq!(
        error_code(
            &db.commit_legacy_lifecycle_operation(
                &key("legacy_principal_c", "op1", "orchestration.send"),
                &status_message(COORD),
                &LegacyLifecycle::MessageOnly
            )
            .unwrap_err()
        ),
        "request_mismatch"
    );
    assert_eq!(
        error_code(
            &db.commit_legacy_lifecycle_operation(
                &key("ghost", "op1", "orchestration.send"),
                &status_message(COORD),
                &LegacyLifecycle::MessageOnly
            )
            .unwrap_err()
        ),
        "request_mismatch"
    );
}

// ── ask / reply ─────────────────────────────────────────────────────────────

#[test]
fn ask_commit_opens_a_durable_question_on_the_legacy_route() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    let options = vec!["yes".to_string(), "no".to_string()];

    let commit = db
        .commit_legacy_ask_operation(
            &key("legacy_principal_w", "ask1", "orchestration.ask"),
            "ship it?",
            &options,
            COORD,
            None,
        )
        .unwrap();

    assert!(!commit.duplicate);
    assert_eq!(commit.question.dispatch_id, "ctx1");
    assert_eq!(commit.question.asker_handle, WORKER);
    assert_eq!(commit.question.status, "pending");
    assert_eq!(commit.message.to_handle, COORD);
    // A legacy-routed ask is still a decision_gate to the pre-Run coordinator.
    assert_eq!(commit.message.message_type, "decision_gate");
    assert_eq!(commit.message.thread_id.as_deref(), Some(commit.message.id.as_str()));
    assert_eq!(
        commit.message.payload.as_deref(),
        Some(
            r#"{"taskId":"t1","dispatchId":"ctx1","question":"ship it?","options":["yes","no"]}"#
        )
    );
    assert_eq!(commit.receipt.effect_id, commit.question.message_id);

    // Replay is a duplicate, not a second question.
    let replay = db
        .commit_legacy_ask_operation(
            &key("legacy_principal_w", "ask1", "orchestration.ask"),
            "ship it?",
            &options,
            COORD,
            None,
        )
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.question.message_id, commit.question.message_id);

    // A new operation key may adopt the still-pending question it names.
    let adopted = db
        .commit_legacy_ask_operation(
            &key("legacy_principal_w", "ask2", "orchestration.ask"),
            "ship it?",
            &options,
            COORD,
            Some(&commit.question.message_id),
        )
        .unwrap();
    // ask1 already claimed that question, so ask2 mints a fresh one.
    assert!(!adopted.duplicate);
    assert_ne!(adopted.question.message_id, commit.question.message_id);
}

#[test]
fn ask_commit_adopts_an_unclaimed_pending_question() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    let options = vec!["yes".to_string()];
    // A question the pre-Run CLI wrote without ever recording a receipt.
    db.connection()
        .execute(
            "INSERT INTO messages (
               id, run_id, delivery_contract, from_handle, to_handle, subject, body, type,
               thread_id, payload
             ) VALUES ('q_old', ?1, 'legacy_direct', ?2, ?3, 'Question', 'ship it?',
                       'decision_gate', 'q_old', ?4)",
            params![
                ADOPTED,
                WORKER,
                COORD,
                r#"{"taskId":"t1","dispatchId":"ctx1","question":"ship it?","options":["yes"]}"#
            ],
        )
        .unwrap();
    db.connection()
        .execute(
            "INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
             VALUES ('q_old', ?1, 'ctx1', ?2)",
            params![ADOPTED, WORKER],
        )
        .unwrap();
    // A second unclaimed thread whose text is different.
    db.connection()
        .execute(
            "INSERT INTO messages (
               id, run_id, delivery_contract, from_handle, to_handle, subject, body, type,
               thread_id, payload
             ) VALUES ('q_other', ?1, 'legacy_direct', ?2, ?3, 'Question', 'something else',
                       'decision_gate', 'q_other', '{}')",
            params![ADOPTED, WORKER, COORD],
        )
        .unwrap();
    db.connection()
        .execute(
            "INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
             VALUES ('q_other', ?1, 'ctx1', ?2)",
            params![ADOPTED, WORKER],
        )
        .unwrap();

    let commit = db
        .commit_legacy_ask_operation(
            &key("legacy_principal_w", "ask1", "orchestration.ask"),
            "ship it?",
            &options,
            COORD,
            Some("q_old"),
        )
        .unwrap();
    assert_eq!(commit.question.message_id, "q_old");
    assert!(!commit.duplicate);

    // A named question whose text does not match this ask is a mismatch.
    assert_eq!(
        error_code(
            &db.commit_legacy_ask_operation(
                &key("legacy_principal_w", "ask2", "orchestration.ask"),
                "ship it?",
                &options,
                COORD,
                Some("q_other"),
            )
            .unwrap_err()
        ),
        "request_mismatch"
    );

    // A question already claimed by an earlier ask receipt is not adopted twice —
    // the retry mints a fresh one rather than failing.
    let fresh = db
        .commit_legacy_ask_operation(
            &key("legacy_principal_w", "ask3", "orchestration.ask"),
            "ship it?",
            &options,
            COORD,
            Some("q_old"),
        )
        .unwrap();
    assert_ne!(fresh.question.message_id, "q_old");
}

#[test]
fn ask_commit_requires_an_active_legacy_dispatch() {
    let db = adopted_store();
    seed_task(&db, "t1", "completed", Some(COORD));
    seed_dispatch(&db, "ctx1", "t1", WORKER, Some(WORKER_PANE), "completed", 0);
    // A settled principal is not committed, so the ask never reaches the dispatch.
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    assert_eq!(
        error_code(
            &db.commit_legacy_ask_operation(
                &key("legacy_principal_w", "ask1", "orchestration.ask"),
                "ship it?",
                &[],
                COORD,
                None,
            )
            .unwrap_err()
        ),
        "request_mismatch"
    );

    // A committed principal whose dispatch has since settled reports that.
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    db.connection()
        .execute("UPDATE dispatch_contexts SET status = 'failed' WHERE id = 'ctx1'", [])
        .unwrap();
    assert_eq!(
        error_code(
            &db.commit_legacy_ask_operation(
                &key("legacy_principal_w", "ask1", "orchestration.ask"),
                "ship it?",
                &[],
                COORD,
                None,
            )
            .unwrap_err()
        ),
        "dispatch_inactive"
    );
}

#[test]
fn reply_commit_answers_a_legacy_question_once() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    db.commit_legacy_compatibility_principal(&coordinator_params()).unwrap();
    let ask = db
        .commit_legacy_ask_operation(
            &key("legacy_principal_w", "ask1", "orchestration.ask"),
            "ship it?",
            &[],
            COORD,
            None,
        )
        .unwrap();

    let reply = db
        .commit_legacy_reply_operation(
            &key("legacy_principal_c", "reply1", "orchestration.reply"),
            &ask.question.message_id,
            "yes",
        )
        .unwrap();

    assert!(!reply.duplicate);
    assert_eq!(reply.question.status, "answered");
    assert_eq!(reply.question.answer_body.as_deref(), Some("yes"));
    assert_eq!(reply.question.answer_message_id.as_deref(), Some(reply.message.id.as_str()));
    assert_eq!(reply.message.to_handle, WORKER);
    assert_eq!(reply.message.subject, "Re: Question");
    assert_eq!(
        reply.message.delivery_contract.as_deref(),
        Some(DELIVERY_CONTRACT_LEGACY_DIRECT)
    );
    assert_eq!(reply.message.thread_id.as_deref(), Some(ask.question.message_id.as_str()));
    // Answering reads the ask so it is not redelivered.
    assert_eq!(db.get_message_by_id(&ask.question.message_id).unwrap().unwrap().read, 1);

    // Replay through the receipt.
    let replay = db
        .commit_legacy_reply_operation(
            &key("legacy_principal_c", "reply1", "orchestration.reply"),
            &ask.question.message_id,
            "yes",
        )
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.message.id, reply.message.id);

    // A second operation with the SAME body is a duplicate of the answer…
    let same_body = db
        .commit_legacy_reply_operation(
            &key("legacy_principal_c", "reply2", "orchestration.reply"),
            &ask.question.message_id,
            "yes",
        )
        .unwrap();
    assert!(same_body.duplicate);
    assert_eq!(same_body.message.id, reply.message.id);
    // …and a different body conflicts.
    assert_eq!(
        error_code(
            &db.commit_legacy_reply_operation(
                &key("legacy_principal_c", "reply3", "orchestration.reply"),
                &ask.question.message_id,
                "no",
            )
            .unwrap_err()
        ),
        "answer_conflict"
    );
}

#[test]
fn reply_commit_refuses_an_unactionable_question() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&coordinator_params()).unwrap();

    assert_eq!(
        error_code(
            &db.commit_legacy_reply_operation(
                &key("legacy_principal_c", "reply1", "orchestration.reply"),
                "ghost",
                "yes",
            )
            .unwrap_err()
        ),
        "question_not_found"
    );

    // A current_delivery ask is the Run's to answer, not the legacy coordinator's.
    seed_message(&db, "q1", DELIVERY_CONTRACT_CURRENT, WORKER, COORD, "question", 0);
    db.connection()
        .execute(
            "INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
             VALUES ('q1', ?1, 'ctx1', ?2)",
            params![ADOPTED, WORKER],
        )
        .unwrap();
    assert_eq!(
        error_code(
            &db.commit_legacy_reply_operation(
                &key("legacy_principal_c", "reply2", "orchestration.reply"),
                "q1",
                "yes",
            )
            .unwrap_err()
        ),
        "question_not_found"
    );

    // Only a committed coordinator principal may reply.
    assert_eq!(
        error_code(
            &db.commit_legacy_reply_operation(
                &key("ghost", "reply3", "orchestration.reply"),
                "q1",
                "yes",
            )
            .unwrap_err()
        ),
        "request_mismatch"
    );
}

// ── completion reconstruction ───────────────────────────────────────────────

#[test]
fn finds_a_worker_completion_by_semantic_identity() {
    let db = adopted_store();
    seed_legacy_attempt(&db, "t1", "ctx1");
    db.commit_legacy_compatibility_principal(&worker_params("ctx1")).unwrap();
    let payload = r#"{"taskId":"t1","dispatchId":"ctx1"}"#;
    db.connection()
        .execute(
            "INSERT INTO messages (
               id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, payload
             ) VALUES ('done1', ?1, 'legacy_direct', ?2, ?3, 'Task complete', 'shipped',
                       'worker_done', ?4)",
            params![ADOPTED, WORKER, COORD, payload],
        )
        .unwrap();

    let query = LegacyWorkerCompletionQuery {
        principal_id: "legacy_principal_w".to_string(),
        task_id: "t1".to_string(),
        recipient_handle: COORD.to_string(),
        subject: "Task complete".to_string(),
        body: "shipped".to_string(),
        payload: Some(payload.to_string()),
    };
    assert_eq!(db.find_legacy_worker_completion(&query).unwrap().unwrap().id, "done1");

    // A different body is a different completion.
    let other = LegacyWorkerCompletionQuery { body: "other".to_string(), ..query.clone() };
    assert!(db.find_legacy_worker_completion(&other).unwrap().is_none());
    // A payload naming another dispatch does not match this principal.
    let foreign_payload = r#"{"taskId":"t1","dispatchId":"ctx9"}"#;
    let foreign = LegacyWorkerCompletionQuery {
        payload: Some(foreign_payload.to_string()),
        ..query.clone()
    };
    db.connection()
        .execute(
            "INSERT INTO messages (
               id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, payload
             ) VALUES ('done2', ?1, 'legacy_direct', ?2, ?3, 'Task complete', 'shipped',
                       'worker_done', ?4)",
            params![ADOPTED, WORKER, COORD, foreign_payload],
        )
        .unwrap();
    assert!(db.find_legacy_worker_completion(&foreign).unwrap().is_none());

    // Two identical completions cannot be told apart.
    db.connection()
        .execute(
            "INSERT INTO messages (
               id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, payload
             ) VALUES ('done3', ?1, 'legacy_direct', ?2, ?3, 'Task complete', 'shipped',
                       'worker_done', ?4)",
            params![ADOPTED, WORKER, COORD, payload],
        )
        .unwrap();
    assert_eq!(
        error_code(&db.find_legacy_worker_completion(&query).unwrap_err()),
        "operation_unknown"
    );

    // An unknown or non-worker principal is refused outright.
    let ghost = LegacyWorkerCompletionQuery { principal_id: "ghost".to_string(), ..query };
    assert_eq!(error_code(&db.find_legacy_worker_completion(&ghost).unwrap_err()), "request_mismatch");
}
