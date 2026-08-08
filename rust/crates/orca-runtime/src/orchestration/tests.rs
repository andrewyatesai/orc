use super::*;

fn msg(id: &str, to: &str, subject: &str) -> NewMessage {
    NewMessage {
        id: id.to_string(),
        from_handle: "coordinator".to_string(),
        to_handle: to.to_string(),
        subject: subject.to_string(),
        body: String::new(),
        message_type: "status".to_string(),
        priority: "normal".to_string(),
        thread_id: None,
        payload: None,
        sender_pane_key: None,
        recipient_pane_key: None,
    }
}

fn status_of(db: &OrchestrationDb, id: &str) -> String {
    db.get_task(id).unwrap().unwrap().status
}

fn new_task(db: &OrchestrationDb, id: &str, spec: &str, deps: &[&str]) {
    db.create_task(id, spec, None, deps, None, None, None, None).unwrap();
}

#[test]
fn creates_schema_on_open() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    assert!(db.get_unread_messages("nobody", None).unwrap().is_empty());
}

#[test]
fn inserts_reads_full_row_then_marks_read() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    let stored = db.send_message(&msg("m1", "worker-a", "do the thing")).unwrap();
    // Full row is returned: read/sequence/created_at populated.
    assert_eq!(stored.read, 0);
    assert!(stored.sequence > 0);
    assert!(!stored.created_at.is_empty());
    db.send_message(&msg("m2", "worker-b", "other thing")).unwrap();

    let inbox = db.get_unread_messages("worker-a", None).unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].id, "m1");
    assert_eq!(inbox[0].subject, "do the thing");

    assert_eq!(db.get_message_by_id("m1").unwrap().unwrap().subject, "do the thing");
    assert!(db.get_message_by_id("nope").unwrap().is_none());

    db.mark_as_read(&["m1"]).unwrap();
    assert!(db.get_unread_messages("worker-a", None).unwrap().is_empty());
    assert_eq!(db.get_unread_messages("worker-b", None).unwrap().len(), 1);
}

#[test]
fn unread_type_filter_and_thread_and_all_for_handle() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    db.send_message(&msg("m1", "w", "status one")).unwrap();
    let mut done = msg("m2", "w", "done");
    done.message_type = "worker_done".to_string();
    db.send_message(&done).unwrap();

    let filtered = db.get_unread_messages("w", Some(&["worker_done".to_string()])).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].message_type, "worker_done");

    // Thread replies addressed to a handle, oldest first, after a cursor.
    let mut outbound = msg("q1", "coord", "question");
    outbound.from_handle = "worker".to_string();
    let outbound = db.send_message(&outbound).unwrap();
    let mut reply = msg("r1", "worker", "reply");
    reply.from_handle = "coord".to_string();
    reply.thread_id = Some(outbound.id.clone());
    db.send_message(&reply).unwrap();
    let replies = db.get_thread_messages_for(&outbound.id, "worker", Some(outbound.sequence)).unwrap();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].id, "r1");

    // Newest-first, capped.
    assert_eq!(db.get_all_messages_for_handle("w", 100, None).unwrap()[0].id, "m2");
}

#[test]
fn message_type_check_constraint_rejects_invalid_type() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    let mut bad = msg("m1", "worker-a", "x");
    bad.message_type = "not-a-real-type".to_string();
    assert!(db.send_message(&bad).is_err());
}

#[test]
fn delivered_marker_is_distinct_from_read_replay_guard() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    db.send_message(&msg("m1", "worker-a", "hello")).unwrap();
    assert_eq!(db.get_undelivered_unread_messages("worker-a", None).unwrap().len(), 1);
    db.mark_as_delivered(&["m1"]).unwrap();
    assert!(db.get_undelivered_unread_messages("worker-a", None).unwrap().is_empty());
    assert_eq!(db.get_unread_messages("worker-a", None).unwrap().len(), 1); // still unread
}

#[test]
fn create_task_deps_drive_initial_status_and_display() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    db.create_task("t1", "build the parser", None, &[], Some("term-1"), Some("Parser"), Some("Build parser"), None)
        .unwrap();
    new_task(&db, "t2", "write tests", &["t1"]);

    let all = db.list_tasks(None, None).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].status, "ready"); // no deps
    assert_eq!(all[0].task_title.as_deref(), Some("Parser"));
    assert_eq!(all[0].display_name.as_deref(), Some("Build parser"));
    assert_eq!(all[0].created_by_terminal_handle.as_deref(), Some("term-1"));
    assert_eq!(all[1].status, "pending"); // has a dep
    assert_eq!(all[1].deps, "[\"t1\"]");
}

#[test]
fn completing_a_task_promotes_ready_dependents_and_stamps_result() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "a", &[]);
    new_task(&db, "t2", "b", &["t1"]);
    new_task(&db, "t3", "c", &["t1", "t2"]);

    db.update_task_status("t1", "completed", Some("done"), Some("2026-01-01T00:00:00.000Z")).unwrap();
    assert_eq!(status_of(&db, "t2"), "ready");
    assert_eq!(status_of(&db, "t3"), "pending");
    let t1 = db.get_task("t1").unwrap().unwrap();
    assert_eq!(t1.result.as_deref(), Some("done"));
    assert!(t1.completed_at.is_some());

    // A later update without a result preserves it (COALESCE); keep t1 completed.
    db.update_task_status("t1", "completed", None, Some("2026-01-02T00:00:00.000Z")).unwrap();
    assert_eq!(db.get_task("t1").unwrap().unwrap().result.as_deref(), Some("done"));

    db.update_task_status("t2", "completed", None, Some("2026-01-01T00:00:00.000Z")).unwrap();
    assert_eq!(status_of(&db, "t3"), "ready");
}

#[test]
fn list_tasks_with_dispatch_surfaces_only_active_assignee() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "ready", "ready task", &[]);
    new_task(&db, "active", "active task", &[]);
    db.create_dispatch_context("active", "term-worker", "ctx1", None, None).unwrap();

    let rows = db.list_tasks_with_dispatch(None).unwrap();
    let ready_row = rows.iter().find(|r| r.task.id == "ready").unwrap();
    let active_row = rows.iter().find(|r| r.task.id == "active").unwrap();
    assert_eq!(ready_row.assignee_handle, None);
    assert_eq!(ready_row.dispatch_id, None);
    assert_eq!(active_row.assignee_handle.as_deref(), Some("term-worker"));
    assert_eq!(active_row.dispatch_id.as_deref(), Some("ctx1"));

    // Completing the task drops it from the "active" join.
    db.update_task_status("active", "completed", None, Some("2026-01-01T00:00:00.000Z")).unwrap();
    let rows = db.list_tasks_with_dispatch(None).unwrap();
    let active_row = rows.iter().find(|r| r.task.id == "active").unwrap();
    assert_eq!(active_row.assignee_handle, None);
    assert_eq!(active_row.dispatch_id, None);
}

#[test]
fn decision_gate_blocks_task_and_resolution_unblocks_it() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "spec", &[]);
    db.create_dispatch_context("t1", "worker-1", "ctx1", None, None).unwrap();

    let gate = db.create_gate("g1", "t1", "Proceed?", &["yes", "no"], None, &NewGatePolicy::default()).unwrap();
    assert_eq!(gate.status, "pending");
    assert_eq!(gate.origin_message_id, None);
    assert_eq!(gate.options, "[\"yes\",\"no\"]");
    assert_eq!(status_of(&db, "t1"), "blocked");
    assert_eq!(db.dispatch_context_by_id("ctx1").unwrap().unwrap().status, "completed");

    let resolved = db.resolve_gate("g1", "yes").unwrap().unwrap();
    assert_eq!(resolved.status, "resolved");
    assert_eq!(resolved.resolution.as_deref(), Some("yes"));
    assert_eq!(status_of(&db, "t1"), "ready");
    assert!(db.list_gates(Some("t1"), Some("pending"), None).unwrap().is_empty());
    assert_eq!(db.list_gates(None, None, None).unwrap().len(), 1);

    // Missing gate resolves to None.
    assert!(db.resolve_gate("nope", "x").unwrap().is_none());

    db.create_gate("g2", "t1", "Again?", &["ok"], None, &NewGatePolicy::default()).unwrap();
    assert_eq!(status_of(&db, "t1"), "blocked");
    let timed = db.timeout_gate("g2").unwrap().unwrap();
    assert_eq!(timed.status, "timeout");
    assert_eq!(status_of(&db, "t1"), "blocked");
}

#[test]
fn dispatch_requires_ready_task_and_one_active_per_assignee() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "dep", "dep", &[]);
    new_task(&db, "t1", "spec1", &["dep"]); // pending
    new_task(&db, "t2", "spec2", &[]); // ready

    assert!(db.create_dispatch_context("t1", "worker-1", "ctx0", None, None).is_err());
    let err = db.create_dispatch_context("nope", "worker-1", "ctxX", None, None).unwrap_err();
    assert!(err.to_string().contains("Task not found: nope"), "{err}");

    db.update_task_status("dep", "completed", None, Some("2026-01-01T00:00:00.000Z")).unwrap();
    assert_eq!(status_of(&db, "t1"), "ready");

    let ctx = db.create_dispatch_context("t1", "worker-1", "ctx1", None, None).unwrap();
    assert_eq!(ctx.status, "dispatched");
    assert_eq!(status_of(&db, "t1"), "dispatched");
    assert_eq!(db.get_active_dispatch_for_terminal("worker-1").unwrap().unwrap().id, "ctx1");

    // The exact "for task" error text is load-bearing for CLI UX.
    let err = db.create_dispatch_context("t2", "worker-1", "ctx2", None, None).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Terminal worker-1 already has an active dispatch (ctx1 for task t1)"
    );

    assert_eq!(db.complete_dispatch("ctx1").unwrap(), 1);
    assert!(db.get_active_dispatch_for_terminal("worker-1").unwrap().is_none());
    let ctx3 = db.create_dispatch_context("t2", "worker-1", "ctx3", None, None).unwrap();
    assert_eq!(ctx3.task_id, "t2");
    assert_eq!(db.get_latest_dispatch_for_terminal("worker-1").unwrap().unwrap().id, "ctx3");
}

#[test]
fn fail_dispatch_carries_failures_and_trips_circuit_breaker_at_three() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "spec", &[]);

    for (ctx_id, expected_count) in [("ctx1", 1_i64), ("ctx2", 2)] {
        let ctx = db.create_dispatch_context("t1", "worker-1", ctx_id, None, None).unwrap();
        assert_eq!(ctx.failure_count, expected_count - 1); // carried forward
        let failed = db.fail_dispatch(ctx_id, "boom").unwrap().unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.failure_count, expected_count);
        assert_eq!(failed.last_failure.as_deref(), Some("boom"));
        assert_eq!(status_of(&db, "t1"), "ready");
    }

    db.create_dispatch_context("t1", "worker-1", "ctx3", None, None).unwrap();
    let broken = db.fail_dispatch("ctx3", "boom").unwrap().unwrap();
    assert_eq!(broken.status, "circuit_broken");
    assert_eq!(broken.failure_count, 3);
    assert_eq!(status_of(&db, "t1"), "failed");

    assert!(db.fail_dispatch("nope", "boom").unwrap().is_none());
}

#[test]
fn heartbeat_only_touches_dispatched_and_stale_detector_respects_threshold() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "spec", &[]);
    db.create_dispatch_context("t1", "worker-1", "ctx1", None, None).unwrap();

    // Fresh dispatch, no heartbeat, is stale against a future threshold.
    let future = "2999-01-01 00:00:00";
    assert_eq!(db.get_stale_dispatches(future).unwrap().len(), 1);

    // A heartbeat newer than the threshold clears staleness; injected value is
    // stored verbatim. The compare is by `datetime()`, not raw bytes (see the
    // mixed-format test below for why that matters in production).
    assert_eq!(db.record_heartbeat("ctx1", "2999-06-01 00:00:00").unwrap(), 1);
    assert_eq!(
        db.dispatch_context_by_id("ctx1").unwrap().unwrap().last_heartbeat_at.as_deref(),
        Some("2999-06-01 00:00:00")
    );
    assert!(db.get_stale_dispatches(future).unwrap().is_empty());

    // A heartbeat older than the threshold → stale again.
    db.record_heartbeat("ctx1", "2000-01-01 00:00:00").unwrap();
    assert_eq!(db.get_stale_dispatches(future).unwrap()[0].id, "ctx1");

    // Nothing is stale against a past threshold (dispatched_at grace).
    assert!(db.get_stale_dispatches("1999-01-01 00:00:00").unwrap().is_empty());

    // Zombie-heartbeat guard: once completed, a heartbeat updates 0 rows.
    db.complete_dispatch("ctx1").unwrap();
    assert_eq!(db.record_heartbeat("ctx1", "2999-06-02 00:00:00").unwrap(), 0);
}

#[test]
fn stale_detector_compares_by_time_across_space_and_iso_t_formats() {
    // Production feeds MIXED formats: columns are written by `datetime('now')`
    // (space-separated) while the caller passes `new Date().toISOString()`
    // (`…T…Z`). A raw byte `<` mis-orders these — space (0x20) < 'T' (0x54) at
    // index 10 — flagging fresh workers as stale. `datetime()`-wrapping both
    // operands makes the compare time-correct.
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "spec", &[]);
    db.create_dispatch_context("t1", "worker-1", "ctx1", None, None).unwrap();
    db.set_dispatch_timestamps("ctx1", Some("2026-07-14 10:00:00"), None).unwrap();

    // ISO-T threshold 5 min AFTER dispatched_at → genuinely stale.
    assert_eq!(db.get_stale_dispatches("2026-07-14T10:05:00.000Z").unwrap().len(), 1);

    // ISO-T threshold 5 min BEFORE dispatched_at → NOT stale. This is the case a
    // raw byte compare gets wrong (it would return the row as stale).
    assert!(db.get_stale_dispatches("2026-07-14T09:55:00.000Z").unwrap().is_empty());

    // A fresh heartbeat (space-format) newer than an ISO-T threshold clears
    // staleness even when dispatched_at is old.
    db.set_dispatch_timestamps("ctx1", Some("2020-01-01 00:00:00"), None).unwrap();
    db.record_heartbeat("ctx1", "2026-07-14 10:00:00").unwrap();
    assert!(db.get_stale_dispatches("2026-07-14T09:55:00.000Z").unwrap().is_empty());
}

#[test]
fn set_dispatch_timestamps_backdates_for_the_grace_window() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "spec", &[]);
    db.create_dispatch_context("t1", "worker-1", "ctx1", None, None).unwrap();

    // With dispatched_at ≈ now (2026) and no heartbeat, a mid-2026 threshold does
    // not make it stale (dispatched_at not < threshold — the grace shields it).
    assert!(db.get_stale_dispatches("2026-01-01 00:00:00").unwrap().is_empty());

    // Backdate dispatched_at before the threshold → now eligible (no heartbeat).
    db.set_dispatch_timestamps("ctx1", Some("2020-01-01 00:00:00"), None).unwrap();
    let stale = db.get_stale_dispatches("2026-01-01 00:00:00").unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].id, "ctx1");
}

#[test]
fn coordinator_run_lifecycle_and_idle_terminals() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    let run = db.create_coordinator_run("run1", "ship it", "coordinator-a", None, None, None).unwrap();
    assert_eq!(run.status, "running");
    assert_eq!(run.poll_interval_ms, 2000);
    assert_eq!(db.active_coordinator_run().unwrap().unwrap().id, "run1");

    let done = db.update_coordinator_run("run1", "completed", Some("2026-01-01T00:00:00.000Z")).unwrap().unwrap();
    assert_eq!(done.status, "completed");
    assert!(done.completed_at.is_some());
    assert!(db.active_coordinator_run().unwrap().is_none());

    let custom = db.create_coordinator_run("run2", "spec", "coordinator-b", Some(500), None, None).unwrap();
    assert_eq!(custom.poll_interval_ms, 500);

    // Idle terminals: handles seen in messages, minus those with active dispatches.
    db.send_message(&msg("m1", "worker-a", "hi")).unwrap();
    db.send_message(&msg("m2", "worker-b", "hi")).unwrap();
    new_task(&db, "t1", "spec", &[]);
    db.create_dispatch_context("t1", "worker-a", "ctx1", None, None).unwrap();
    let idle = db.get_idle_terminals(&["coordinator"]).unwrap();
    assert!(idle.contains(&"worker-b".to_string()));
    assert!(!idle.contains(&"worker-a".to_string())); // busy
    assert!(!idle.contains(&"coordinator".to_string())); // excluded
}

#[test]
fn active_coordinator_runs_lists_every_running_row_newest_first() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    assert!(db.active_coordinator_runs().unwrap().is_empty());

    db.create_coordinator_run("run1", "spec-a", "coordinator-a", None, None, None).unwrap();
    db.create_coordinator_run("run2", "spec-b", "coordinator-b", None, None, None).unwrap();
    db.create_coordinator_run("run3", "spec-c", "coordinator-c", None, None, None).unwrap();
    db.update_coordinator_run("run2", "failed", Some("2026-01-01T00:00:00.000Z")).unwrap();

    let active: Vec<String> = db.active_coordinator_runs().unwrap().into_iter().map(|r| r.id).collect();
    // created_at has second granularity, so rowid breaks the tie newest-first.
    assert_eq!(active, vec!["run3".to_string(), "run1".to_string()]);
}

#[test]
fn reset_helpers_clear_the_right_tables() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    db.send_message(&msg("m1", "a", "hi")).unwrap();
    new_task(&db, "t1", "spec", &[]);
    db.create_dispatch_context("t1", "worker-1", "ctx1", None, None).unwrap();

    db.reset_tasks().unwrap();
    assert_eq!(db.get_inbox(10).unwrap().len(), 1);
    assert!(db.list_tasks(None, None).unwrap().is_empty());
    assert!(db.dispatch_context_by_id("ctx1").unwrap().is_none());

    db.reset_messages().unwrap();
    assert!(db.get_inbox(10).unwrap().is_empty());
}

#[test]
fn gate_round_trips_its_origin_message_id() {
    // Why: gateResolve answers the blocked `ask` through this column. If it does not
    // survive insert -> select the task unblocks while the worker hangs to timeout —
    // the failure that looks fixed on the board.
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "spec", &[]);

    let gate = db.create_gate("g1", "t1", "Ship it?", &["yes"], Some("msg-42"), &NewGatePolicy::default()).unwrap();
    assert_eq!(gate.origin_message_id.as_deref(), Some("msg-42"));

    // Survives the re-read paths the resolve flow actually uses.
    assert_eq!(
        db.gate_by_id("g1").unwrap().unwrap().origin_message_id.as_deref(),
        Some("msg-42")
    );
    let resolved = db.resolve_gate("g1", "yes").unwrap().unwrap();
    assert_eq!(resolved.origin_message_id.as_deref(), Some("msg-42"));

    // A directly-created gate (orchestration.gateCreate) has no origin and must stay null.
    db.create_gate("g2", "t1", "No origin?", &[], None, &NewGatePolicy::default()).unwrap();
    assert_eq!(db.gate_by_id("g2").unwrap().unwrap().origin_message_id, None);
    assert_eq!(
        db.list_gates(Some("t1"), None, None).unwrap().iter().filter(|g| g.origin_message_id.is_some()).count(),
        1
    );
}

// ---- dispatch capabilities (v10) ----

const PANE_A: &str = "tab1:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
const PANE_A_REMINTED: &str = "tab9:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
const PANE_B: &str = "tab1:1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d";

fn dispatched(pane_key: Option<&str>) -> OrchestrationDb {
    let db = OrchestrationDb::open_in_memory().unwrap();
    new_task(&db, "t1", "do the thing", &[]);
    db.create_dispatch_context("t1", "worker-1", "ctx1", pane_key, None).unwrap();
    db
}

fn mint(db: &OrchestrationDb, pane_key: &str, incarnation: &str) -> String {
    db.mint_dispatch_capability(&MintCapabilityParams {
        dispatch_id: "ctx1".to_string(),
        pane_key: pane_key.to_string(),
        process_incarnation: incarnation.to_string(),
    })
    .unwrap()
}

fn identity(capability: &str, pane_key: &str, incarnation: &str) -> DispatchIdentity {
    DispatchIdentity {
        dispatch_id: "ctx1".to_string(),
        capability: Some(capability.to_string()),
        pane_key: Some(pane_key.to_string()),
        process_incarnation: Some(incarnation.to_string()),
    }
}

fn reason(verdict: &CapabilityVerdict) -> String {
    match verdict {
        CapabilityVerdict::Invalid { reason, .. } => reason.clone(),
        CapabilityVerdict::Valid { .. } => panic!("expected an invalid verdict"),
    }
}

fn coded(error: orca_store::StoreError) -> (String, String) {
    let orca_store::StoreError::Message(text) = error else {
        panic!("expected a coded message error")
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed[ORCHESTRATION_ERROR_MARKER], serde_json::json!(true));
    (
        parsed["code"].as_str().unwrap().to_string(),
        parsed["message"].as_str().unwrap().to_string(),
    )
}

#[test]
fn mint_persists_only_the_hash_and_binds_the_identity() {
    let db = dispatched(None);
    let capability = mint(&db, PANE_A, "pid-1");
    // `dcap_` + unpadded base64url of 32 random bytes; every mint is fresh.
    assert!(capability.starts_with("dcap_"));
    assert_eq!(capability.len(), "dcap_".len() + 43);
    assert_ne!(capability, mint(&db, PANE_A, "pid-1"));
    let capability = mint(&db, PANE_A, "pid-1");

    let row = db.dispatch_context_by_id("ctx1").unwrap().unwrap();
    assert_eq!(
        row.capability_hash.as_deref(),
        Some(capability::hash_dispatch_capability(&capability).as_str())
    );
    assert_eq!(row.assignee_pane_key.as_deref(), Some(PANE_A));
    assert_eq!(row.process_incarnation.as_deref(), Some("pid-1"));
    assert_eq!(row.capability_revoked_at, None);
    assert_eq!(row.contract_version, CURRENT_CONTRACT_VERSION);
    // The token itself is never written anywhere on the row.
    let stored = serde_json::to_string(&row).unwrap();
    assert!(!stored.contains(&capability), "the capability must not be persisted: {stored}");
}

#[test]
fn mint_then_verify_round_trips_across_a_pane_remint() {
    let db = dispatched(Some(PANE_A));
    let capability = mint(&db, PANE_A, "pid-1");
    assert_eq!(
        db.verify_dispatch_capability(&identity(&capability, PANE_A, "pid-1")).unwrap(),
        CapabilityVerdict::valid()
    );
    // Same stable pane leaf behind a new tab id still verifies.
    assert_eq!(
        db.verify_dispatch_capability(&identity(&capability, PANE_A_REMINTED, "pid-1")).unwrap(),
        CapabilityVerdict::valid()
    );
}

#[test]
fn verify_rejects_every_failure_mode_with_the_ported_reason() {
    let db = dispatched(Some(PANE_A));

    let unknown = DispatchIdentity { dispatch_id: "nope".to_string(), ..Default::default() };
    assert_eq!(
        reason(&db.verify_dispatch_capability(&unknown).unwrap()),
        "Dispatch nope was not found."
    );

    // Never minted.
    assert_eq!(
        reason(&db.verify_dispatch_capability(&identity("dcap_x", PANE_A, "pid-1")).unwrap()),
        "Dispatch ctx1 has no lifecycle capability."
    );

    let capability = mint(&db, PANE_A, "pid-1");

    // Missing / empty presented capability, checked before the compare.
    let mut missing = identity(&capability, PANE_A, "pid-1");
    missing.capability = None;
    assert_eq!(
        reason(&db.verify_dispatch_capability(&missing).unwrap()),
        "The Dispatch capability is missing."
    );
    missing.capability = Some(String::new());
    assert_eq!(
        reason(&db.verify_dispatch_capability(&missing).unwrap()),
        "The Dispatch capability is missing."
    );

    // Wrong token.
    assert_eq!(
        reason(&db.verify_dispatch_capability(&identity("dcap_wrong", PANE_A, "pid-1")).unwrap()),
        "The Dispatch capability is invalid."
    );

    // Right token, wrong pane — and a missing pane is equally a wrong pane.
    assert_eq!(
        reason(&db.verify_dispatch_capability(&identity(&capability, PANE_B, "pid-1")).unwrap()),
        "The caller is not the Dispatch pane."
    );
    let mut no_pane = identity(&capability, PANE_A, "pid-1");
    no_pane.pane_key = None;
    assert_eq!(
        reason(&db.verify_dispatch_capability(&no_pane).unwrap()),
        "The caller is not the Dispatch pane."
    );

    // Right token and pane, restarted process.
    assert_eq!(
        reason(&db.verify_dispatch_capability(&identity(&capability, PANE_A, "pid-2")).unwrap()),
        "The Dispatch process incarnation changed."
    );
    let mut no_incarnation = identity(&capability, PANE_A, "pid-1");
    no_incarnation.process_incarnation = None;
    assert_eq!(
        reason(&db.verify_dispatch_capability(&no_incarnation).unwrap()),
        "The Dispatch process incarnation changed."
    );

    // Revocation is checked before the token itself.
    db.revoke_dispatch_capability("ctx1").unwrap();
    assert_eq!(
        reason(&db.verify_dispatch_capability(&identity(&capability, PANE_A, "pid-1")).unwrap()),
        "Dispatch ctx1 capability is revoked."
    );
}

#[test]
fn remint_rebinds_the_identity_and_clears_a_prior_revocation() {
    let db = dispatched(Some(PANE_A));
    let first = mint(&db, PANE_A, "pid-1");
    db.revoke_dispatch_capability("ctx1").unwrap();

    let second = db
        .mint_dispatch_capability(&MintCapabilityParams {
            dispatch_id: "ctx1".to_string(),
            pane_key: PANE_A_REMINTED.to_string(),
            process_incarnation: "pid-2".to_string(),
        })
        .unwrap();

    let row = db.dispatch_context_by_id("ctx1").unwrap().unwrap();
    assert_eq!(row.capability_revoked_at, None);
    assert_eq!(row.process_incarnation.as_deref(), Some("pid-2"));
    // The superseded token no longer verifies; the new one does.
    assert_eq!(
        reason(&db.verify_dispatch_capability(&identity(&first, PANE_A_REMINTED, "pid-2")).unwrap()),
        "The Dispatch capability is invalid."
    );
    assert_eq!(
        db.verify_dispatch_capability(&identity(&second, PANE_A_REMINTED, "pid-2")).unwrap(),
        CapabilityVerdict::valid()
    );
}

#[test]
fn mint_refuses_an_inactive_or_unknown_dispatch_with_a_coded_error() {
    let db = dispatched(Some(PANE_A));
    db.complete_dispatch("ctx1").unwrap();
    let (code, message) = coded(
        db.mint_dispatch_capability(&MintCapabilityParams {
            dispatch_id: "ctx1".to_string(),
            pane_key: PANE_A.to_string(),
            process_incarnation: "pid-1".to_string(),
        })
        .unwrap_err(),
    );
    assert_eq!(code, "dispatch_inactive");
    assert_eq!(message, "Dispatch ctx1 is not active.");
    // A completed dispatch keeps no capability it never had.
    assert_eq!(db.dispatch_context_by_id("ctx1").unwrap().unwrap().capability_hash, None);

    let (code, message) = coded(
        db.mint_dispatch_capability(&MintCapabilityParams {
            dispatch_id: "nope".to_string(),
            pane_key: PANE_A.to_string(),
            process_incarnation: "pid-1".to_string(),
        })
        .unwrap_err(),
    );
    assert_eq!(code, "dispatch_inactive");
    assert_eq!(message, "Dispatch nope is not active.");
}

#[test]
fn revoke_keeps_the_hash_and_the_first_stamp_and_ignores_unknown_ids() {
    let db = dispatched(Some(PANE_A));
    let capability = mint(&db, PANE_A, "pid-1");
    db.revoke_dispatch_capability("ctx1").unwrap();
    let first = db.dispatch_context_by_id("ctx1").unwrap().unwrap();
    assert!(first.capability_revoked_at.is_some());
    // The hash survives so a later presentation is diagnosable.
    assert_eq!(
        first.capability_hash.as_deref(),
        Some(capability::hash_dispatch_capability(&capability).as_str())
    );

    db.connection()
        .execute(
            "UPDATE dispatch_contexts SET capability_revoked_at = '2020-01-01 00:00:00' WHERE id = 'ctx1'",
            [],
        )
        .unwrap();
    db.revoke_dispatch_capability("ctx1").unwrap();
    assert_eq!(
        db.dispatch_context_by_id("ctx1").unwrap().unwrap().capability_revoked_at.as_deref(),
        Some("2020-01-01 00:00:00")
    );

    // Unknown ids are a silent no-op, exactly like the TS UPDATE.
    db.revoke_dispatch_capability("nope").unwrap();
}

#[test]
fn dispatch_completion_and_failure_revoke_a_minted_capability() {
    let db = dispatched(Some(PANE_A));
    let capability = mint(&db, PANE_A, "pid-1");
    db.complete_dispatch("ctx1").unwrap();
    assert_eq!(
        reason(&db.verify_dispatch_capability(&identity(&capability, PANE_A, "pid-1")).unwrap()),
        "Dispatch ctx1 capability is revoked."
    );

    // Failure revokes too; a capability-less dispatch stays unstamped (legacy
    // rows keep their exact pre-v10 bytes).
    new_task(&db, "t2", "again", &[]);
    db.create_dispatch_context("t2", "worker-2", "ctx2", Some(PANE_B), None).unwrap();
    let minted = db
        .mint_dispatch_capability(&MintCapabilityParams {
            dispatch_id: "ctx2".to_string(),
            pane_key: PANE_B.to_string(),
            process_incarnation: "pid-9".to_string(),
        })
        .unwrap();
    assert!(!minted.is_empty());
    db.fail_dispatch("ctx2", "boom").unwrap();
    assert!(db.dispatch_context_by_id("ctx2").unwrap().unwrap().capability_revoked_at.is_some());

    new_task(&db, "t3", "no capability", &[]);
    db.create_dispatch_context("t3", "worker-3", "ctx3", None, None).unwrap();
    db.complete_dispatch("ctx3").unwrap();
    assert_eq!(db.dispatch_context_by_id("ctx3").unwrap().unwrap().capability_revoked_at, None);
}

#[test]
fn launch_token_commitment_is_first_write_wins() {
    let db = dispatched(Some(PANE_A));
    let committed = db.commit_dispatch_launch_token_hash("ctx1", "hash-1").unwrap();
    assert_eq!(committed.launch_token_hash.as_deref(), Some("hash-1"));

    // Re-committing the same hash is idempotent.
    let again = db.commit_dispatch_launch_token_hash("ctx1", "hash-1").unwrap();
    assert_eq!(again.launch_token_hash.as_deref(), Some("hash-1"));

    let (code, message) = coded(db.commit_dispatch_launch_token_hash("ctx1", "hash-2").unwrap_err());
    assert_eq!(code, "request_mismatch");
    assert_eq!(message, "Dispatch ctx1 already has a different launch-token commitment.");
    assert_eq!(
        db.dispatch_context_by_id("ctx1").unwrap().unwrap().launch_token_hash.as_deref(),
        Some("hash-1")
    );
}

#[test]
fn launch_token_commitment_rejects_unknown_and_legacy_contract_dispatches() {
    let db = dispatched(Some(PANE_A));
    let (code, message) = coded(db.commit_dispatch_launch_token_hash("nope", "hash-1").unwrap_err());
    assert_eq!(code, "dispatch_not_found");
    assert_eq!(message, "Dispatch nope was not found.");

    db.connection()
        .execute("UPDATE dispatch_contexts SET contract_version = 0 WHERE id = 'ctx1'", [])
        .unwrap();
    let (code, message) = coded(db.commit_dispatch_launch_token_hash("ctx1", "hash-1").unwrap_err());
    assert_eq!(code, "request_mismatch");
    assert_eq!(message, "Dispatch ctx1 does not use the current contract.");
    assert_eq!(db.dispatch_context_by_id("ctx1").unwrap().unwrap().launch_token_hash, None);
}

#[test]
fn process_currency_needs_both_an_equivalent_pane_and_the_same_incarnation() {
    let db = dispatched(Some(PANE_A));
    mint(&db, PANE_A, "pid-1");

    assert!(db.is_dispatch_process_current(&identity("", PANE_A, "pid-1")).unwrap());
    assert!(db.is_dispatch_process_current(&identity("", PANE_A_REMINTED, "pid-1")).unwrap());
    assert!(!db.is_dispatch_process_current(&identity("", PANE_B, "pid-1")).unwrap());
    assert!(!db.is_dispatch_process_current(&identity("", PANE_A, "pid-2")).unwrap());

    let mut absent = identity("", PANE_A, "pid-1");
    absent.pane_key = None;
    assert!(!db.is_dispatch_process_current(&absent).unwrap());
    let mut absent = identity("", PANE_A, "pid-1");
    absent.process_incarnation = None;
    assert!(!db.is_dispatch_process_current(&absent).unwrap());

    // Unknown dispatch, and a dispatch that never bound a process.
    let unknown = DispatchIdentity { dispatch_id: "nope".to_string(), ..Default::default() };
    assert!(!db.is_dispatch_process_current(&unknown).unwrap());
    new_task(&db, "t2", "second", &[]);
    db.create_dispatch_context("t2", "worker-2", "ctx2", None, None).unwrap();
    let unbound = DispatchIdentity {
        dispatch_id: "ctx2".to_string(),
        capability: None,
        pane_key: Some(PANE_A.to_string()),
        process_incarnation: Some("pid-1".to_string()),
    };
    assert!(!db.is_dispatch_process_current(&unbound).unwrap());
}

#[test]
fn rejection_marker_carries_the_caller_supplied_code() {
    let db = OrchestrationDb::open_in_memory().unwrap();
    let mut done = msg("m1", "coordinator", "done");
    done.message_type = "worker_done".to_string();
    db.send_message(&done).unwrap();
    let rewritten = db
        .convert_lifecycle_message_to_rejection("m1", "bad token", Some("dispatch_capability_invalid"))
        .unwrap()
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(rewritten.payload.as_deref().unwrap()).unwrap();
    assert_eq!(payload["_orcaLifecycleRejection"]["code"], "dispatch_capability_invalid");
    assert_eq!(payload["_orcaLifecycleRejection"]["reason"], "bad token");

    // Default keeps the historic code, so existing callers are unchanged.
    let mut hb = msg("m2", "coordinator", "alive");
    hb.message_type = "heartbeat".to_string();
    db.send_message(&hb).unwrap();
    let rewritten = db.convert_lifecycle_message_to_rejection("m2", "not yours", None).unwrap().unwrap();
    let payload: serde_json::Value = serde_json::from_str(rewritten.payload.as_deref().unwrap()).unwrap();
    assert_eq!(payload["_orcaLifecycleRejection"]["code"], "sender_not_assignee");
}
