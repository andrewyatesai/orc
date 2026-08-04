//! Golden tests for the `user_version` migration ladder against live TS
//! behavior. The expected `sqlite_master` texts, row dumps, and versions below
//! were captured from `src/main/runtime/orchestration/db.ts` running under
//! node:sqlite (temporary vitest harness, since deleted); the Rust port must
//! reproduce them byte-for-byte.
//!
//! Regenerated at schema v22 for the upstream v1.4.165 sync (13 new tables, and
//! upstream numbering for v7+ — the two fork columns now land outside the ladder).

use orca_runtime::{NewMessage, OrchestrationDb};
use rusqlite::types::Value;
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

// ── fixture: the original v1 schema (db.ts as of commit c9391e203) ──
// Real v1 deployments never set user_version, so a v1 DB sits at 0.

const V1_SCHEMA_SQL: &str = r#"
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT NOT NULL,
        from_handle   TEXT NOT NULL,
        to_handle     TEXT NOT NULL,
        subject       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'status'
          CHECK(type IN (
            'status', 'dispatch', 'worker_done', 'merge_ready',
            'escalation', 'handoff', 'decision_gate'
          )),
        priority      TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('normal', 'high', 'urgent')),
        thread_id     TEXT,
        payload       TEXT,
        read          INTEGER NOT NULL DEFAULT 0,
        sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
      CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT,
        spec          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN (
            'pending', 'ready', 'dispatched',
            'completed', 'failed', 'blocked'
          )),
        deps          TEXT NOT NULL DEFAULT '[]',
        result        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE IF NOT EXISTS dispatch_contexts (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        assignee_handle TEXT,
        status          TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
        failure_count   INTEGER NOT NULL DEFAULT 0,
        last_failure    TEXT,
        dispatched_at   TEXT,
        completed_at    TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_contexts(task_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_contexts(status);

      CREATE TABLE IF NOT EXISTS decision_gates (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'resolved', 'timeout')),
        resolution    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_gates_task ON decision_gates(task_id);
      CREATE INDEX IF NOT EXISTS idx_gates_status ON decision_gates(status);

      CREATE TABLE IF NOT EXISTS coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT
      );
    "#;

/// Deterministic seed rows (identical to the TS golden run).
const V1_SEED_SQL: &str = r#"
INSERT INTO messages (id, from_handle, to_handle, subject, body, type, priority, thread_id, payload, read, created_at)
VALUES
  ('msg_a1', 'coordinator', 'worker-1', 'first', 'body one', 'dispatch', 'high', 'thread-1', '{"k":1}', 1, '2025-01-02 03:04:05'),
  ('msg_a2', 'worker-1', 'coordinator', 'second', '', 'status', 'normal', NULL, NULL, 0, '2025-01-02 03:04:06');
INSERT INTO tasks (id, parent_id, spec, status, deps, result, created_at, completed_at)
VALUES
  ('task_a1', NULL, 'build the thing', 'completed', '[]', 'done', '2025-01-02 03:00:00', '2025-01-02 04:00:00'),
  ('task_a2', 'task_a1', 'test the thing', 'pending', '["task_a1"]', NULL, '2025-01-02 03:00:01', NULL);
INSERT INTO dispatch_contexts (id, task_id, assignee_handle, status, failure_count, last_failure, dispatched_at, completed_at, created_at)
VALUES ('ctx_a1', 'task_a1', 'worker-1', 'completed', 1, 'flaky once', '2025-01-02 03:10:00', '2025-01-02 04:00:00', '2025-01-02 03:10:00');
INSERT INTO decision_gates (id, task_id, question, options, status, resolution, created_at, resolved_at)
VALUES ('gate_a1', 'task_a1', 'Proceed?', '["yes","no"]', 'resolved', 'yes', '2025-01-02 03:20:00', '2025-01-02 03:25:00');
INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, poll_interval_ms, created_at, completed_at)
VALUES ('run_a1', 'orchestrate', 'running', 'coordinator', 2000, '2025-01-02 03:00:00', NULL);
"#;

/// A genuine upstream-v6 messages table: the fresh DDL minus every post-v6
/// column (`run_id`, `delivery_contract`) and minus the fork's
/// `recipient_pane_key`. Under upstream numbering v6 is the last pre-Run rung.
const V6_MESSAGES_SQL: &str = r#"CREATE TABLE messages (
        id            TEXT NOT NULL,
        from_handle   TEXT NOT NULL,
        to_handle     TEXT NOT NULL,
        subject       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'status'
          CHECK(type IN (
            'status', 'dispatch', 'worker_done', 'merge_ready',
            'escalation', 'handoff', 'decision_gate', 'heartbeat'
          )),
        priority      TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('normal', 'high', 'urgent')),
        thread_id     TEXT,
        payload       TEXT,
        read          INTEGER NOT NULL DEFAULT 0,
        sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at  TEXT,
        sender_pane_key TEXT
      )"#;

const V6_SEED_SQL: &str = "INSERT INTO messages (id, from_handle, to_handle, subject, sender_pane_key, created_at)
                 VALUES ('msg_v6', 'coord', 'worker-1', 'pre-v7', 'tab_1:leaf_1', '2025-01-02 03:04:05')";

type MasterEntry = (&'static str, &'static str, Option<&'static str>);

// ── goldens: sqlite_master sql text captured from the TS implementation ──

const COORDINATOR_RUNS_SQL: &str = r#"CREATE TABLE coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT,
        scheduler_lost_at   TEXT
      )"#;

const DECISION_GATES_SQL: &str = r#"CREATE TABLE decision_gates (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL DEFAULT 'run_legacy_local',
        task_id       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'resolved', 'timeout')),
        resolution    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT,
        origin_message_id TEXT
      )"#;

const DELIVERIES_SQL: &str = r#"CREATE TABLE deliveries (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL,
        consumer_generation   INTEGER NOT NULL,
        message_ids           TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'outstanding'
          CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_at       TEXT
      )"#;

const DISPATCH_CONTEXTS_SQL: &str = r#"CREATE TABLE dispatch_contexts (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL DEFAULT 'run_legacy_local',
        task_id             TEXT NOT NULL,
        contract_version    INTEGER NOT NULL DEFAULT 1,
        launch_token_hash   TEXT,
        assignee_handle     TEXT,
        assignee_pane_key   TEXT,
        capability_hash     TEXT,
        process_incarnation TEXT,
        capability_revoked_at TEXT,
        status              TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
        failure_count       INTEGER NOT NULL DEFAULT 0,
        last_failure        TEXT,
        dispatched_at       TEXT,
        completed_at        TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at   TEXT
      )"#;

const FEDERATED_DISPATCHES_SQL: &str = r#"CREATE TABLE federated_dispatches (
        dispatch_id             TEXT PRIMARY KEY,
        environment_id          TEXT NOT NULL,
        environment_name        TEXT NOT NULL,
        peer_fingerprint        TEXT NOT NULL,
        remote_runtime_epoch    TEXT,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        remote_worktree_id      TEXT,
        remote_terminal_handle  TEXT,
        to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      )"#;

const FEDERATION_RELAY_ITEMS_SQL: &str = r#"CREATE TABLE federation_relay_items (
        dispatch_id   TEXT NOT NULL,
        direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
        sequence      INTEGER NOT NULL,
        message_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        byte_count    INTEGER NOT NULL,
        acked_at      TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (dispatch_id, direction, sequence),
        UNIQUE (dispatch_id, direction, message_id)
      )"#;

const IDX_DELIVERIES_ONE_OUTSTANDING_SQL: &str = r#"CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(run_id) WHERE status = 'outstanding'"#;

const IDX_DELIVERIES_RUN_CREATED_SQL: &str = r#"CREATE INDEX idx_deliveries_run_created
        ON deliveries(run_id, created_at)"#;

const IDX_DISPATCH_ASSIGNEE_HANDLE_SQL: &str = r#"CREATE INDEX idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle)"#;

const IDX_DISPATCH_RUN_STATUS_SQL: &str = r#"CREATE INDEX idx_dispatch_run_status ON dispatch_contexts(run_id, status)"#;

const IDX_DISPATCH_STATUS_SQL: &str = r#"CREATE INDEX idx_dispatch_status ON dispatch_contexts(status)"#;

const IDX_DISPATCH_TASK_SQL: &str = r#"CREATE INDEX idx_dispatch_task ON dispatch_contexts(task_id)"#;

const IDX_FEDERATION_RELAY_PENDING_SQL: &str = r#"CREATE INDEX idx_federation_relay_pending
        ON federation_relay_items(dispatch_id, direction, acked_at, sequence)"#;

const IDX_GATES_RUN_STATUS_SQL: &str = r#"CREATE INDEX idx_gates_run_status ON decision_gates(run_id, status)"#;

const IDX_GATES_STATUS_SQL: &str = r#"CREATE INDEX idx_gates_status ON decision_gates(status)"#;

const IDX_GATES_TASK_SQL: &str = r#"CREATE INDEX idx_gates_task ON decision_gates(task_id)"#;

const IDX_INBOX_SQL: &str = r#"CREATE INDEX idx_inbox ON messages(to_handle, read)"#;

const IDX_LEGACY_PRINCIPAL_COORDINATOR_SQL: &str = r#"CREATE UNIQUE INDEX idx_legacy_principal_coordinator
        ON legacy_compatibility_principals(run_id)
        WHERE role = 'coordinator'"#;

const IDX_LEGACY_PRINCIPAL_DISPATCH_SQL: &str = r#"CREATE UNIQUE INDEX idx_legacy_principal_dispatch
        ON legacy_compatibility_principals(dispatch_id)
        WHERE role = 'worker'"#;

const IDX_MESSAGES_DELIVERY_CONTRACT_SQL: &str = r#"CREATE INDEX idx_messages_delivery_contract
        ON messages(run_id, delivery_contract, to_handle, read, sequence)"#;

const IDX_MESSAGES_ID_SQL: &str = r#"CREATE UNIQUE INDEX idx_messages_id ON messages(id)"#;

const IDX_MESSAGES_RUN_SEQUENCE_SQL: &str = r#"CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence)"#;

const IDX_MESSAGES_UNDELIVERED_INBOX_SQL: &str = r#"CREATE INDEX idx_messages_undelivered_inbox
        ON messages(to_handle, read, delivered_at, sequence)
    "#;

const IDX_QUESTIONS_DISPATCH_STATUS_SQL: &str = r#"CREATE INDEX idx_questions_dispatch_status
        ON question_threads(dispatch_id, status)"#;

const IDX_REMOTE_QUESTIONS_DISPATCH_STATUS_SQL: &str = r#"CREATE INDEX idx_remote_questions_dispatch_status
        ON remote_questions(dispatch_id, status)"#;

const IDX_RUNS_COORDINATOR_PANE_SQL: &str = r#"CREATE INDEX idx_runs_coordinator_pane ON runs(coordinator_pane_key)"#;

const IDX_RUNS_COORDINATOR_PANE_LEAF_SQL: &str = r#"CREATE INDEX idx_runs_coordinator_pane_leaf
        ON runs(substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1))
        WHERE coordinator_pane_key IS NOT NULL"#;

const IDX_TASKS_PARENT_SQL: &str = r#"CREATE INDEX idx_tasks_parent ON tasks(parent_id)"#;

const IDX_TASKS_RUN_STATUS_SQL: &str = r#"CREATE INDEX idx_tasks_run_status ON tasks(run_id, status)"#;

const IDX_TASKS_STATUS_SQL: &str = r#"CREATE INDEX idx_tasks_status ON tasks(status)"#;

const IDX_THREAD_SQL: &str = r#"CREATE INDEX idx_thread ON messages(thread_id)"#;

const LEGACY_ADOPTIONS_SQL: &str = r#"CREATE TABLE legacy_adoptions (
        source_run_id        TEXT PRIMARY KEY,
        adopted_run_id       TEXT UNIQUE NOT NULL,
        scheduler_state_lost INTEGER NOT NULL,
        adopted_at           TEXT NOT NULL DEFAULT (datetime('now'))
      )"#;

const LEGACY_COMPATIBILITY_PRINCIPALS_SQL: &str = r#"CREATE TABLE legacy_compatibility_principals (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL,
        dispatch_id         TEXT,
        role                TEXT NOT NULL CHECK(role IN ('worker', 'coordinator')),
        host_scope          TEXT NOT NULL,
        terminal_handle     TEXT NOT NULL,
        pane_key            TEXT NOT NULL,
        launch_token_hash   TEXT NOT NULL,
        process_incarnation TEXT,
        status              TEXT NOT NULL
          CHECK(status IN ('committed', 'settled', 'revoked')),
        CHECK(
          (role = 'worker' AND dispatch_id IS NOT NULL) OR
          (role = 'coordinator' AND dispatch_id IS NULL)
        ),
        UNIQUE(role, run_id, dispatch_id)
      )"#;

const LEGACY_MAIL_RECEIPTS_SQL: &str = r#"CREATE TABLE legacy_mail_receipts (
        principal_id    TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY(principal_id, message_id)
      )"#;

const LEGACY_OPERATION_RECEIPTS_SQL: &str = r#"CREATE TABLE legacy_operation_receipts (
        principal_id   TEXT NOT NULL,
        operation_key  TEXT NOT NULL,
        method         TEXT NOT NULL,
        payload_hash   TEXT NOT NULL,
        effect_id      TEXT NOT NULL,
        response_json  TEXT NOT NULL,
        completed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(principal_id, operation_key)
      )"#;

const MESSAGES_SQL: &str = r#"CREATE TABLE messages (
        id            TEXT NOT NULL,
        run_id        TEXT NOT NULL DEFAULT 'run_legacy_local',
        delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
          CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
        from_handle   TEXT NOT NULL,
        to_handle     TEXT NOT NULL,
        subject       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'status'
          CHECK(type IN (
            'status', 'dispatch', 'worker_done', 'merge_ready',
            'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
          )),
        priority      TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('normal', 'high', 'urgent')),
        thread_id     TEXT,
        payload       TEXT,
        read          INTEGER NOT NULL DEFAULT 0,
        sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at  TEXT,
        sender_pane_key TEXT,
        recipient_pane_key TEXT
      )"#;

const MUTATION_RECEIPTS_SQL: &str = r#"CREATE TABLE mutation_receipts (
        caller_fingerprint  TEXT NOT NULL,
        request_id          TEXT NOT NULL,
        method              TEXT NOT NULL,
        payload_hash        TEXT NOT NULL,
        state               TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending', 'completed')),
        receipt             TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (caller_fingerprint, request_id)
      )"#;

const QUESTION_THREADS_SQL: &str = r#"CREATE TABLE question_threads (
        message_id                TEXT PRIMARY KEY,
        run_id                    TEXT NOT NULL,
        dispatch_id               TEXT NOT NULL,
        asker_handle              TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'answered', 'closed')),
        answer_message_id         TEXT,
        answer_body               TEXT,
        answered_by_generation    INTEGER,
        created_at                TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at               TEXT,
        closed_at                 TEXT
      )"#;

const REMOTE_DISPATCH_ATTACHMENTS_SQL: &str = r#"CREATE TABLE remote_dispatch_attachments (
        dispatch_id             TEXT PRIMARY KEY,
        task_id                 TEXT NOT NULL,
        home_peer_fingerprint   TEXT NOT NULL,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        runtime_epoch           TEXT NOT NULL,
        capability_hash         TEXT,
        pane_key                TEXT,
        process_incarnation     TEXT,
        state                   TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned'
          )),
        stage                   TEXT NOT NULL DEFAULT 'accepted',
        worktree_id             TEXT,
        terminal_handle         TEXT,
        setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
        effects                 TEXT NOT NULL DEFAULT '[]',
        residual_resources      TEXT NOT NULL DEFAULT '[]',
        to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
        last_error              TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      )"#;

const REMOTE_QUESTIONS_SQL: &str = r#"CREATE TABLE remote_questions (
        message_id        TEXT PRIMARY KEY,
        dispatch_id       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'answered', 'closed')),
        answer_message_id TEXT,
        answer_body       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at       TEXT
      )"#;

const RUNS_SQL: &str = r#"CREATE TABLE runs (
        id                    TEXT PRIMARY KEY,
        objective             TEXT NOT NULL,
        home_database         TEXT NOT NULL DEFAULT 'this_database',
        coordinator_handle    TEXT,
        coordinator_pane_key  TEXT,
        consumer_generation   INTEGER NOT NULL DEFAULT 0,
        legacy                INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      )"#;

const SQLITE_SEQUENCE_SQL: &str = r#"CREATE TABLE sqlite_sequence(name,seq)"#;

const TASKS_SQL: &str = r#"CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL DEFAULT 'run_legacy_local',
        parent_id     TEXT,
        created_by_terminal_handle TEXT,
        task_title    TEXT,
        display_name  TEXT,
        spec          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN (
            'pending', 'ready', 'dispatched',
            'completed', 'failed', 'blocked'
          )),
        deps          TEXT NOT NULL DEFAULT '[]',
        result        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT
      )"#;

const WORKER_DISPATCHES_SQL: &str = r#"CREATE TABLE worker_dispatches (
        dispatch_id            TEXT PRIMARY KEY,
        runtime_epoch          TEXT,
        state                  TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned'
          )),
        stage                  TEXT NOT NULL DEFAULT 'accepted',
        worktree_id            TEXT,
        agent_terminal_handle  TEXT,
        setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
        effects                TEXT NOT NULL DEFAULT '[]',
        residual_resources     TEXT NOT NULL DEFAULT '[]',
        start_options          TEXT NOT NULL DEFAULT '{}',
        last_error             TEXT,
        created_at             TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
      )"#;

const COORDINATOR_RUNS_2_SQL: &str = r#"CREATE TABLE coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT
      , scheduler_lost_at TEXT)"#;

const DECISION_GATES_2_SQL: &str = r#"CREATE TABLE decision_gates (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'resolved', 'timeout')),
        resolution    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT
      , run_id TEXT NOT NULL DEFAULT 'run_legacy_local', origin_message_id TEXT)"#;

const DISPATCH_CONTEXTS_2_SQL: &str = r#"CREATE TABLE dispatch_contexts (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        assignee_handle TEXT,
        status          TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
        failure_count   INTEGER NOT NULL DEFAULT 0,
        last_failure    TEXT,
        dispatched_at   TEXT,
        completed_at    TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      , last_heartbeat_at TEXT, assignee_pane_key TEXT, run_id TEXT NOT NULL DEFAULT 'run_legacy_local', capability_hash TEXT, process_incarnation TEXT, capability_revoked_at TEXT, contract_version INTEGER NOT NULL DEFAULT 1, launch_token_hash TEXT)"#;

const IDX_MESSAGES_UNDELIVERED_INBOX_2_SQL: &str = r#"CREATE INDEX idx_messages_undelivered_inbox
              ON messages(to_handle, read, delivered_at, sequence)"#;

const MESSAGES_2_SQL: &str = r#"CREATE TABLE "messages" (
              id            TEXT NOT NULL,
              from_handle   TEXT NOT NULL,
              to_handle     TEXT NOT NULL,
              subject       TEXT NOT NULL,
              body          TEXT NOT NULL DEFAULT '',
              type          TEXT NOT NULL DEFAULT 'status'
                CHECK(type IN (
                  'status', 'dispatch', 'worker_done', 'merge_ready',
                  'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
                )),
              priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK(priority IN ('normal', 'high', 'urgent')),
              thread_id     TEXT,
              payload       TEXT,
              read          INTEGER NOT NULL DEFAULT 0,
              sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at    TEXT NOT NULL DEFAULT (datetime('now')),
              delivered_at  TEXT
            , sender_pane_key TEXT, run_id TEXT NOT NULL DEFAULT 'run_legacy_local', delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
         CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')), recipient_pane_key TEXT)"#;

const TASKS_2_SQL: &str = r#"CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT,
        spec          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN (
            'pending', 'ready', 'dispatched',
            'completed', 'failed', 'blocked'
          )),
        deps          TEXT NOT NULL DEFAULT '[]',
        result        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT
      , created_by_terminal_handle TEXT, task_title TEXT, display_name TEXT, run_id TEXT NOT NULL DEFAULT 'run_legacy_local')"#;

const IDX_MESSAGES_UNDELIVERED_INBOX_3_SQL: &str = r#"CREATE INDEX idx_messages_undelivered_inbox
            ON messages(to_handle, read, delivered_at, sequence)"#;

const MESSAGES_3_SQL: &str = r#"CREATE TABLE "messages" (
            id              TEXT NOT NULL,
            run_id          TEXT NOT NULL DEFAULT 'run_legacy_local',
            from_handle     TEXT NOT NULL,
            to_handle       TEXT NOT NULL,
            subject         TEXT NOT NULL,
            body            TEXT NOT NULL DEFAULT '',
            type            TEXT NOT NULL DEFAULT 'status'
              CHECK(type IN (
                'status', 'dispatch', 'worker_done', 'merge_ready',
                'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
              )),
            priority        TEXT NOT NULL DEFAULT 'normal'
              CHECK(priority IN ('normal', 'high', 'urgent')),
            thread_id       TEXT,
            payload         TEXT,
            read            INTEGER NOT NULL DEFAULT 0,
            sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at    TEXT,
            sender_pane_key TEXT
          , delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
         CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')), recipient_pane_key TEXT)"#;

fn expected_fresh_master() -> Vec<MasterEntry> {
    vec![
        ("table", "coordinator_runs", Some(COORDINATOR_RUNS_SQL)),
        ("table", "decision_gates", Some(DECISION_GATES_SQL)),
        ("table", "deliveries", Some(DELIVERIES_SQL)),
        ("table", "dispatch_contexts", Some(DISPATCH_CONTEXTS_SQL)),
        ("table", "federated_dispatches", Some(FEDERATED_DISPATCHES_SQL)),
        ("table", "federation_relay_items", Some(FEDERATION_RELAY_ITEMS_SQL)),
        ("index", "idx_deliveries_one_outstanding", Some(IDX_DELIVERIES_ONE_OUTSTANDING_SQL)),
        ("index", "idx_deliveries_run_created", Some(IDX_DELIVERIES_RUN_CREATED_SQL)),
        ("index", "idx_dispatch_assignee_handle", Some(IDX_DISPATCH_ASSIGNEE_HANDLE_SQL)),
        ("index", "idx_dispatch_run_status", Some(IDX_DISPATCH_RUN_STATUS_SQL)),
        ("index", "idx_dispatch_status", Some(IDX_DISPATCH_STATUS_SQL)),
        ("index", "idx_dispatch_task", Some(IDX_DISPATCH_TASK_SQL)),
        ("index", "idx_federation_relay_pending", Some(IDX_FEDERATION_RELAY_PENDING_SQL)),
        ("index", "idx_gates_run_status", Some(IDX_GATES_RUN_STATUS_SQL)),
        ("index", "idx_gates_status", Some(IDX_GATES_STATUS_SQL)),
        ("index", "idx_gates_task", Some(IDX_GATES_TASK_SQL)),
        ("index", "idx_inbox", Some(IDX_INBOX_SQL)),
        ("index", "idx_legacy_principal_coordinator", Some(IDX_LEGACY_PRINCIPAL_COORDINATOR_SQL)),
        ("index", "idx_legacy_principal_dispatch", Some(IDX_LEGACY_PRINCIPAL_DISPATCH_SQL)),
        ("index", "idx_messages_delivery_contract", Some(IDX_MESSAGES_DELIVERY_CONTRACT_SQL)),
        ("index", "idx_messages_id", Some(IDX_MESSAGES_ID_SQL)),
        ("index", "idx_messages_run_sequence", Some(IDX_MESSAGES_RUN_SEQUENCE_SQL)),
        ("index", "idx_messages_undelivered_inbox", Some(IDX_MESSAGES_UNDELIVERED_INBOX_SQL)),
        ("index", "idx_questions_dispatch_status", Some(IDX_QUESTIONS_DISPATCH_STATUS_SQL)),
        ("index", "idx_remote_questions_dispatch_status", Some(IDX_REMOTE_QUESTIONS_DISPATCH_STATUS_SQL)),
        ("index", "idx_runs_coordinator_pane", Some(IDX_RUNS_COORDINATOR_PANE_SQL)),
        ("index", "idx_runs_coordinator_pane_leaf", Some(IDX_RUNS_COORDINATOR_PANE_LEAF_SQL)),
        ("index", "idx_tasks_parent", Some(IDX_TASKS_PARENT_SQL)),
        ("index", "idx_tasks_run_status", Some(IDX_TASKS_RUN_STATUS_SQL)),
        ("index", "idx_tasks_status", Some(IDX_TASKS_STATUS_SQL)),
        ("index", "idx_thread", Some(IDX_THREAD_SQL)),
        ("table", "legacy_adoptions", Some(LEGACY_ADOPTIONS_SQL)),
        ("table", "legacy_compatibility_principals", Some(LEGACY_COMPATIBILITY_PRINCIPALS_SQL)),
        ("table", "legacy_mail_receipts", Some(LEGACY_MAIL_RECEIPTS_SQL)),
        ("table", "legacy_operation_receipts", Some(LEGACY_OPERATION_RECEIPTS_SQL)),
        ("table", "messages", Some(MESSAGES_SQL)),
        ("table", "mutation_receipts", Some(MUTATION_RECEIPTS_SQL)),
        ("table", "question_threads", Some(QUESTION_THREADS_SQL)),
        ("table", "remote_dispatch_attachments", Some(REMOTE_DISPATCH_ATTACHMENTS_SQL)),
        ("table", "remote_questions", Some(REMOTE_QUESTIONS_SQL)),
        ("table", "runs", Some(RUNS_SQL)),
        ("index", "sqlite_autoindex_coordinator_runs_1", None),
        ("index", "sqlite_autoindex_decision_gates_1", None),
        ("index", "sqlite_autoindex_deliveries_1", None),
        ("index", "sqlite_autoindex_dispatch_contexts_1", None),
        ("index", "sqlite_autoindex_federated_dispatches_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_2", None),
        ("index", "sqlite_autoindex_legacy_adoptions_1", None),
        ("index", "sqlite_autoindex_legacy_adoptions_2", None),
        ("index", "sqlite_autoindex_legacy_compatibility_principals_1", None),
        ("index", "sqlite_autoindex_legacy_compatibility_principals_2", None),
        ("index", "sqlite_autoindex_legacy_mail_receipts_1", None),
        ("index", "sqlite_autoindex_legacy_operation_receipts_1", None),
        ("index", "sqlite_autoindex_mutation_receipts_1", None),
        ("index", "sqlite_autoindex_question_threads_1", None),
        ("index", "sqlite_autoindex_remote_dispatch_attachments_1", None),
        ("index", "sqlite_autoindex_remote_questions_1", None),
        ("index", "sqlite_autoindex_runs_1", None),
        ("index", "sqlite_autoindex_tasks_1", None),
        ("index", "sqlite_autoindex_worker_dispatches_1", None),
        ("table", "sqlite_sequence", Some(SQLITE_SEQUENCE_SQL)),
        ("table", "tasks", Some(TASKS_SQL)),
        ("table", "worker_dispatches", Some(WORKER_DISPATCHES_SQL)),
    ]
}

fn expected_v1_master() -> Vec<MasterEntry> {
    vec![
        ("table", "coordinator_runs", Some(COORDINATOR_RUNS_2_SQL)),
        ("table", "decision_gates", Some(DECISION_GATES_2_SQL)),
        ("table", "deliveries", Some(DELIVERIES_SQL)),
        ("table", "dispatch_contexts", Some(DISPATCH_CONTEXTS_2_SQL)),
        ("table", "federated_dispatches", Some(FEDERATED_DISPATCHES_SQL)),
        ("table", "federation_relay_items", Some(FEDERATION_RELAY_ITEMS_SQL)),
        ("index", "idx_deliveries_one_outstanding", Some(IDX_DELIVERIES_ONE_OUTSTANDING_SQL)),
        ("index", "idx_deliveries_run_created", Some(IDX_DELIVERIES_RUN_CREATED_SQL)),
        ("index", "idx_dispatch_assignee_handle", Some(IDX_DISPATCH_ASSIGNEE_HANDLE_SQL)),
        ("index", "idx_dispatch_run_status", Some(IDX_DISPATCH_RUN_STATUS_SQL)),
        ("index", "idx_dispatch_status", Some(IDX_DISPATCH_STATUS_SQL)),
        ("index", "idx_dispatch_task", Some(IDX_DISPATCH_TASK_SQL)),
        ("index", "idx_federation_relay_pending", Some(IDX_FEDERATION_RELAY_PENDING_SQL)),
        ("index", "idx_gates_run_status", Some(IDX_GATES_RUN_STATUS_SQL)),
        ("index", "idx_gates_status", Some(IDX_GATES_STATUS_SQL)),
        ("index", "idx_gates_task", Some(IDX_GATES_TASK_SQL)),
        ("index", "idx_inbox", Some(IDX_INBOX_SQL)),
        ("index", "idx_legacy_principal_coordinator", Some(IDX_LEGACY_PRINCIPAL_COORDINATOR_SQL)),
        ("index", "idx_legacy_principal_dispatch", Some(IDX_LEGACY_PRINCIPAL_DISPATCH_SQL)),
        ("index", "idx_messages_delivery_contract", Some(IDX_MESSAGES_DELIVERY_CONTRACT_SQL)),
        ("index", "idx_messages_id", Some(IDX_MESSAGES_ID_SQL)),
        ("index", "idx_messages_run_sequence", Some(IDX_MESSAGES_RUN_SEQUENCE_SQL)),
        ("index", "idx_messages_undelivered_inbox", Some(IDX_MESSAGES_UNDELIVERED_INBOX_2_SQL)),
        ("index", "idx_questions_dispatch_status", Some(IDX_QUESTIONS_DISPATCH_STATUS_SQL)),
        ("index", "idx_remote_questions_dispatch_status", Some(IDX_REMOTE_QUESTIONS_DISPATCH_STATUS_SQL)),
        ("index", "idx_runs_coordinator_pane", Some(IDX_RUNS_COORDINATOR_PANE_SQL)),
        ("index", "idx_runs_coordinator_pane_leaf", Some(IDX_RUNS_COORDINATOR_PANE_LEAF_SQL)),
        ("index", "idx_tasks_parent", Some(IDX_TASKS_PARENT_SQL)),
        ("index", "idx_tasks_run_status", Some(IDX_TASKS_RUN_STATUS_SQL)),
        ("index", "idx_tasks_status", Some(IDX_TASKS_STATUS_SQL)),
        ("index", "idx_thread", Some(IDX_THREAD_SQL)),
        ("table", "legacy_adoptions", Some(LEGACY_ADOPTIONS_SQL)),
        ("table", "legacy_compatibility_principals", Some(LEGACY_COMPATIBILITY_PRINCIPALS_SQL)),
        ("table", "legacy_mail_receipts", Some(LEGACY_MAIL_RECEIPTS_SQL)),
        ("table", "legacy_operation_receipts", Some(LEGACY_OPERATION_RECEIPTS_SQL)),
        ("table", "messages", Some(MESSAGES_2_SQL)),
        ("table", "mutation_receipts", Some(MUTATION_RECEIPTS_SQL)),
        ("table", "question_threads", Some(QUESTION_THREADS_SQL)),
        ("table", "remote_dispatch_attachments", Some(REMOTE_DISPATCH_ATTACHMENTS_SQL)),
        ("table", "remote_questions", Some(REMOTE_QUESTIONS_SQL)),
        ("table", "runs", Some(RUNS_SQL)),
        ("index", "sqlite_autoindex_coordinator_runs_1", None),
        ("index", "sqlite_autoindex_decision_gates_1", None),
        ("index", "sqlite_autoindex_deliveries_1", None),
        ("index", "sqlite_autoindex_dispatch_contexts_1", None),
        ("index", "sqlite_autoindex_federated_dispatches_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_2", None),
        ("index", "sqlite_autoindex_legacy_adoptions_1", None),
        ("index", "sqlite_autoindex_legacy_adoptions_2", None),
        ("index", "sqlite_autoindex_legacy_compatibility_principals_1", None),
        ("index", "sqlite_autoindex_legacy_compatibility_principals_2", None),
        ("index", "sqlite_autoindex_legacy_mail_receipts_1", None),
        ("index", "sqlite_autoindex_legacy_operation_receipts_1", None),
        ("index", "sqlite_autoindex_mutation_receipts_1", None),
        ("index", "sqlite_autoindex_question_threads_1", None),
        ("index", "sqlite_autoindex_remote_dispatch_attachments_1", None),
        ("index", "sqlite_autoindex_remote_questions_1", None),
        ("index", "sqlite_autoindex_runs_1", None),
        ("index", "sqlite_autoindex_tasks_1", None),
        ("index", "sqlite_autoindex_worker_dispatches_1", None),
        ("table", "sqlite_sequence", Some(SQLITE_SEQUENCE_SQL)),
        ("table", "tasks", Some(TASKS_2_SQL)),
        ("table", "worker_dispatches", Some(WORKER_DISPATCHES_SQL)),
    ]
}

fn expected_v6_master() -> Vec<MasterEntry> {
    vec![
        ("table", "coordinator_runs", Some(COORDINATOR_RUNS_SQL)),
        ("table", "decision_gates", Some(DECISION_GATES_SQL)),
        ("table", "deliveries", Some(DELIVERIES_SQL)),
        ("table", "dispatch_contexts", Some(DISPATCH_CONTEXTS_SQL)),
        ("table", "federated_dispatches", Some(FEDERATED_DISPATCHES_SQL)),
        ("table", "federation_relay_items", Some(FEDERATION_RELAY_ITEMS_SQL)),
        ("index", "idx_deliveries_one_outstanding", Some(IDX_DELIVERIES_ONE_OUTSTANDING_SQL)),
        ("index", "idx_deliveries_run_created", Some(IDX_DELIVERIES_RUN_CREATED_SQL)),
        ("index", "idx_dispatch_assignee_handle", Some(IDX_DISPATCH_ASSIGNEE_HANDLE_SQL)),
        ("index", "idx_dispatch_run_status", Some(IDX_DISPATCH_RUN_STATUS_SQL)),
        ("index", "idx_dispatch_status", Some(IDX_DISPATCH_STATUS_SQL)),
        ("index", "idx_dispatch_task", Some(IDX_DISPATCH_TASK_SQL)),
        ("index", "idx_federation_relay_pending", Some(IDX_FEDERATION_RELAY_PENDING_SQL)),
        ("index", "idx_gates_run_status", Some(IDX_GATES_RUN_STATUS_SQL)),
        ("index", "idx_gates_status", Some(IDX_GATES_STATUS_SQL)),
        ("index", "idx_gates_task", Some(IDX_GATES_TASK_SQL)),
        ("index", "idx_inbox", Some(IDX_INBOX_SQL)),
        ("index", "idx_legacy_principal_coordinator", Some(IDX_LEGACY_PRINCIPAL_COORDINATOR_SQL)),
        ("index", "idx_legacy_principal_dispatch", Some(IDX_LEGACY_PRINCIPAL_DISPATCH_SQL)),
        ("index", "idx_messages_delivery_contract", Some(IDX_MESSAGES_DELIVERY_CONTRACT_SQL)),
        ("index", "idx_messages_id", Some(IDX_MESSAGES_ID_SQL)),
        ("index", "idx_messages_run_sequence", Some(IDX_MESSAGES_RUN_SEQUENCE_SQL)),
        ("index", "idx_messages_undelivered_inbox", Some(IDX_MESSAGES_UNDELIVERED_INBOX_3_SQL)),
        ("index", "idx_questions_dispatch_status", Some(IDX_QUESTIONS_DISPATCH_STATUS_SQL)),
        ("index", "idx_remote_questions_dispatch_status", Some(IDX_REMOTE_QUESTIONS_DISPATCH_STATUS_SQL)),
        ("index", "idx_runs_coordinator_pane", Some(IDX_RUNS_COORDINATOR_PANE_SQL)),
        ("index", "idx_runs_coordinator_pane_leaf", Some(IDX_RUNS_COORDINATOR_PANE_LEAF_SQL)),
        ("index", "idx_tasks_parent", Some(IDX_TASKS_PARENT_SQL)),
        ("index", "idx_tasks_run_status", Some(IDX_TASKS_RUN_STATUS_SQL)),
        ("index", "idx_tasks_status", Some(IDX_TASKS_STATUS_SQL)),
        ("index", "idx_thread", Some(IDX_THREAD_SQL)),
        ("table", "legacy_adoptions", Some(LEGACY_ADOPTIONS_SQL)),
        ("table", "legacy_compatibility_principals", Some(LEGACY_COMPATIBILITY_PRINCIPALS_SQL)),
        ("table", "legacy_mail_receipts", Some(LEGACY_MAIL_RECEIPTS_SQL)),
        ("table", "legacy_operation_receipts", Some(LEGACY_OPERATION_RECEIPTS_SQL)),
        ("table", "messages", Some(MESSAGES_3_SQL)),
        ("table", "mutation_receipts", Some(MUTATION_RECEIPTS_SQL)),
        ("table", "question_threads", Some(QUESTION_THREADS_SQL)),
        ("table", "remote_dispatch_attachments", Some(REMOTE_DISPATCH_ATTACHMENTS_SQL)),
        ("table", "remote_questions", Some(REMOTE_QUESTIONS_SQL)),
        ("table", "runs", Some(RUNS_SQL)),
        ("index", "sqlite_autoindex_coordinator_runs_1", None),
        ("index", "sqlite_autoindex_decision_gates_1", None),
        ("index", "sqlite_autoindex_deliveries_1", None),
        ("index", "sqlite_autoindex_dispatch_contexts_1", None),
        ("index", "sqlite_autoindex_federated_dispatches_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_2", None),
        ("index", "sqlite_autoindex_legacy_adoptions_1", None),
        ("index", "sqlite_autoindex_legacy_adoptions_2", None),
        ("index", "sqlite_autoindex_legacy_compatibility_principals_1", None),
        ("index", "sqlite_autoindex_legacy_compatibility_principals_2", None),
        ("index", "sqlite_autoindex_legacy_mail_receipts_1", None),
        ("index", "sqlite_autoindex_legacy_operation_receipts_1", None),
        ("index", "sqlite_autoindex_mutation_receipts_1", None),
        ("index", "sqlite_autoindex_question_threads_1", None),
        ("index", "sqlite_autoindex_remote_dispatch_attachments_1", None),
        ("index", "sqlite_autoindex_remote_questions_1", None),
        ("index", "sqlite_autoindex_runs_1", None),
        ("index", "sqlite_autoindex_tasks_1", None),
        ("index", "sqlite_autoindex_worker_dispatches_1", None),
        ("table", "sqlite_sequence", Some(SQLITE_SEQUENCE_SQL)),
        ("table", "tasks", Some(TASKS_SQL)),
        ("table", "worker_dispatches", Some(WORKER_DISPATCHES_SQL)),
    ]
}

fn expected_future_master() -> Vec<MasterEntry> {
    vec![
        ("table", "coordinator_runs", Some(COORDINATOR_RUNS_SQL)),
        ("table", "decision_gates", Some(DECISION_GATES_SQL)),
        ("table", "deliveries", Some(DELIVERIES_SQL)),
        ("table", "dispatch_contexts", Some(DISPATCH_CONTEXTS_SQL)),
        ("table", "federated_dispatches", Some(FEDERATED_DISPATCHES_SQL)),
        ("table", "federation_relay_items", Some(FEDERATION_RELAY_ITEMS_SQL)),
        ("index", "idx_deliveries_one_outstanding", Some(IDX_DELIVERIES_ONE_OUTSTANDING_SQL)),
        ("index", "idx_deliveries_run_created", Some(IDX_DELIVERIES_RUN_CREATED_SQL)),
        ("index", "idx_dispatch_assignee_handle", Some(IDX_DISPATCH_ASSIGNEE_HANDLE_SQL)),
        ("index", "idx_dispatch_status", Some(IDX_DISPATCH_STATUS_SQL)),
        ("index", "idx_dispatch_task", Some(IDX_DISPATCH_TASK_SQL)),
        ("index", "idx_federation_relay_pending", Some(IDX_FEDERATION_RELAY_PENDING_SQL)),
        ("index", "idx_gates_status", Some(IDX_GATES_STATUS_SQL)),
        ("index", "idx_gates_task", Some(IDX_GATES_TASK_SQL)),
        ("index", "idx_inbox", Some(IDX_INBOX_SQL)),
        ("index", "idx_messages_id", Some(IDX_MESSAGES_ID_SQL)),
        ("index", "idx_messages_undelivered_inbox", Some(IDX_MESSAGES_UNDELIVERED_INBOX_SQL)),
        ("index", "idx_remote_questions_dispatch_status", Some(IDX_REMOTE_QUESTIONS_DISPATCH_STATUS_SQL)),
        ("index", "idx_runs_coordinator_pane_leaf", Some(IDX_RUNS_COORDINATOR_PANE_LEAF_SQL)),
        ("index", "idx_tasks_parent", Some(IDX_TASKS_PARENT_SQL)),
        ("index", "idx_tasks_status", Some(IDX_TASKS_STATUS_SQL)),
        ("index", "idx_thread", Some(IDX_THREAD_SQL)),
        ("table", "messages", Some(MESSAGES_SQL)),
        ("table", "mutation_receipts", Some(MUTATION_RECEIPTS_SQL)),
        ("table", "remote_dispatch_attachments", Some(REMOTE_DISPATCH_ATTACHMENTS_SQL)),
        ("table", "remote_questions", Some(REMOTE_QUESTIONS_SQL)),
        ("table", "runs", Some(RUNS_SQL)),
        ("index", "sqlite_autoindex_coordinator_runs_1", None),
        ("index", "sqlite_autoindex_decision_gates_1", None),
        ("index", "sqlite_autoindex_deliveries_1", None),
        ("index", "sqlite_autoindex_dispatch_contexts_1", None),
        ("index", "sqlite_autoindex_federated_dispatches_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_1", None),
        ("index", "sqlite_autoindex_federation_relay_items_2", None),
        ("index", "sqlite_autoindex_mutation_receipts_1", None),
        ("index", "sqlite_autoindex_remote_dispatch_attachments_1", None),
        ("index", "sqlite_autoindex_remote_questions_1", None),
        ("index", "sqlite_autoindex_runs_1", None),
        ("index", "sqlite_autoindex_tasks_1", None),
        ("index", "sqlite_autoindex_worker_dispatches_1", None),
        ("table", "sqlite_sequence", Some(SQLITE_SEQUENCE_SQL)),
        ("table", "tasks", Some(TASKS_SQL)),
        ("table", "worker_dispatches", Some(WORKER_DISPATCHES_SQL)),
    ]
}

// ── dump/assert machinery ──

fn temp_db_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("orca-runtime-user-version-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.join("orchestration.db")
}

fn open_orchestration(path: &PathBuf) -> Result<OrchestrationDb, orca_store::StoreError> {
    OrchestrationDb::open(path.to_str().unwrap())
}

fn dump_master(conn: &Connection) -> Vec<(String, String, Option<String>)> {
    let mut stmt = conn
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name")
        .unwrap();
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.map(Result::unwrap).collect()
}

fn assert_master_matches(actual: &[(String, String, Option<String>)], expected: &[MasterEntry]) {
    for ((a_type, a_name, a_sql), (e_type, e_name, e_sql)) in actual.iter().zip(expected.iter()) {
        assert_eq!(a_name, e_name, "sqlite_master name order");
        assert_eq!(a_type, e_type, "sqlite_master type for {e_name}");
        assert_eq!(a_sql.as_deref(), *e_sql, "sqlite_master sql for {e_name}");
    }
    assert_eq!(actual.len(), expected.len(), "sqlite_master entry count");
}

/// `col=value|...` per row, NULL spelled out — same encoding as the TS golden.
fn dump_rows(conn: &Connection, table: &str, order_by: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY {order_by}"))
        .unwrap();
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let mut rows = stmt.query([]).unwrap();
    let mut out = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        let mut parts = Vec::with_capacity(columns.len());
        for (i, column) in columns.iter().enumerate() {
            let rendered = match row.get::<_, Value>(i).unwrap() {
                Value::Null => "NULL".to_string(),
                Value::Integer(n) => n.to_string(),
                Value::Text(text) => text,
                other => panic!("unexpected value type in {table}.{column}: {other:?}"),
            };
            parts.push(format!("{column}={rendered}"));
        }
        out.push(parts.join("|"));
    }
    out
}

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap()
}

fn seed_v1_fixture(path: &PathBuf) {
    let fixture = Connection::open(path).unwrap();
    fixture.execute_batch(V1_SCHEMA_SQL).unwrap();
    fixture.execute_batch(V1_SEED_SQL).unwrap();
    // v1 code never wrote user_version — leave it at 0.
    assert_eq!(user_version(&fixture), 0);
}

fn seed_v6_fixture(path: &PathBuf) {
    let fixture = Connection::open(path).unwrap();
    fixture.execute_batch(&format!("{V6_MESSAGES_SQL};")).unwrap();
    fixture.execute_batch(V6_SEED_SQL).unwrap();
    fixture.execute_batch("PRAGMA user_version = 6").unwrap();
}

// ── (a) fresh open ──

#[test]
fn fresh_open_matches_ts_fresh_database() {
    let path = temp_db_path("fresh");
    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 22, "fresh DB lands on SCHEMA_VERSION");
    let journal: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)).unwrap();
    assert_eq!(journal, "wal", "journal_mode=WAL persists in the DB file");
    assert_master_matches(&dump_master(&conn), &expected_fresh_master());
}

// ── (b) v1 fixture migrates to current with schema + data preserved ──

#[test]
fn v1_database_migrates_to_current_preserving_ddl_and_data() {
    let path = temp_db_path("v1-migrate");
    seed_v1_fixture(&path);

    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 22);
    assert_master_matches(&dump_master(&conn), &expected_v1_master());

    // Data preservation, asserted on the columns the legacy DATA migrations do
    // not rewrite (those are covered by `legacy_data_migrations_match_ts`).
    assert_eq!(
        dump_rows(&conn, "messages", "sequence")
            .iter()
            .map(|row| row.split("|delivered_at=").next().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec![
            r#"id=msg_a1|from_handle=coordinator|to_handle=worker-1|subject=first|body=body one|type=dispatch|priority=high|thread_id=thread-1|payload={"k":1}|read=1|sequence=1|created_at=2025-01-02 03:04:05"#,
            "id=msg_a2|from_handle=worker-1|to_handle=coordinator|subject=second|body=|type=status|priority=normal|thread_id=NULL|payload=NULL|read=0|sequence=2|created_at=2025-01-02 03:04:06",
        ]
    );
    assert_eq!(
        dump_rows(&conn, "tasks", "id")
            .iter()
            .map(|row| row.split("|created_by_terminal_handle=").next().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec![
            "id=task_a1|parent_id=NULL|spec=build the thing|status=completed|deps=[]|result=done|created_at=2025-01-02 03:00:00|completed_at=2025-01-02 04:00:00",
            r#"id=task_a2|parent_id=task_a1|spec=test the thing|status=pending|deps=["task_a1"]|result=NULL|created_at=2025-01-02 03:00:01|completed_at=NULL"#,
        ]
    );
    assert_eq!(
        dump_rows(&conn, "dispatch_contexts", "id")
            .iter()
            .map(|row| row.split("|last_heartbeat_at=").next().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec![
            "id=ctx_a1|task_id=task_a1|assignee_handle=worker-1|status=completed|failure_count=1|last_failure=flaky once|dispatched_at=2025-01-02 03:10:00|completed_at=2025-01-02 04:00:00|created_at=2025-01-02 03:10:00",
        ]
    );
    assert_eq!(
        dump_rows(&conn, "decision_gates", "id")
            .iter()
            .map(|row| row.split("|run_id=").next().unwrap().to_string())
            .collect::<Vec<_>>(),
        // A gate written before the origin column has no ask to answer, so the
        // resolve path skips the thread reply and behaves as it did pre-migration.
        vec![
            r#"id=gate_a1|task_id=task_a1|question=Proceed?|options=["yes","no"]|status=resolved|resolution=yes|created_at=2025-01-02 03:20:00|resolved_at=2025-01-02 03:25:00"#,
        ]
    );
    assert_eq!(dump_rows(&conn, "sqlite_sequence", "name"), vec!["name=messages|seq=2"]);
    // v19 stamps every uncapabilitied legacy dispatch back to contract 0.
    let contract_version: i64 = conn
        .query_row("SELECT contract_version FROM dispatch_contexts WHERE id = 'ctx_a1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(contract_version, 0, "legacy dispatch keeps LEGACY_CONTRACT_VERSION");
    drop(conn);

    // Behavioral proof the widened CHECKs took: 'heartbeat' and 'question' pass.
    let db = open_orchestration(&path).unwrap();
    for (id, message_type) in [("msg_hb", "heartbeat"), ("msg_q", "question")] {
        db.send_message(&NewMessage {
            id: id.to_string(),
            from_handle: "worker-1".to_string(),
            to_handle: "coordinator".to_string(),
            subject: message_type.to_string(),
            body: String::new(),
            message_type: message_type.to_string(),
            priority: "normal".to_string(),
            thread_id: None,
            payload: None,
            sender_pane_key: None,
            recipient_pane_key: None,
        })
        .unwrap();
    }
}

// ── (c) already-current open is a no-op ──

#[test]
fn already_current_open_is_a_noop() {
    let path = temp_db_path("noop");
    {
        let db = open_orchestration(&path).unwrap();
        db.create_task("t1", "spec one", None, &[], Some("term-1"), None, None, None).unwrap();
    }
    // Why: a row written to the synthetic legacy Run makes the stored version
    // untrustworthy (hasConsistentLegacyAdoption is false while that Run holds a
    // graph), so this open replays the ladder and adopts it — the same as TS.
    // The baseline is taken afterwards, which also proves adoption is idempotent.
    drop(open_orchestration(&path).unwrap());

    let (version_before, master_before, tasks_before) = {
        let conn = Connection::open(&path).unwrap();
        (user_version(&conn), dump_master(&conn), dump_rows(&conn, "tasks", "id"))
    };
    assert_eq!(version_before, 22);
    assert!(
        !tasks_before[0].contains("run_id=run_legacy_local"),
        "the legacy Run's graph was adopted onto a real Run"
    );

    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), version_before);
    assert_eq!(dump_master(&conn), master_before);
    assert_eq!(dump_rows(&conn, "tasks", "id"), tasks_before);
}

// ── (d) future user_version: mirrors TS — migrate() short-circuits, the
// version is left untouched, and createTables still creates missing tables ──

#[test]
fn future_user_version_is_left_untouched() {
    let path = temp_db_path("future");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 99").unwrap();
    }

    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 99, "future version is not clamped or bumped");
    // Captured from TS: createTables alone, without any ladder-only table.
    assert_master_matches(&dump_master(&conn), &expected_future_master());
}

// ── migration failure: transaction rolls back, version stays put ──

#[test]
fn failed_migration_rolls_back_atomically() {
    let path = temp_db_path("rollback");
    {
        let fixture = Connection::open(&path).unwrap();
        fixture.execute_batch(V1_SCHEMA_SQL).unwrap();
        // Poison the rebuild: the v1 → v2 step's CREATE TABLE messages_new fails.
        fixture.execute_batch("CREATE TABLE messages_new (blocker TEXT)").unwrap();
    }

    assert!(open_orchestration(&path).is_err(), "constructor propagates the migration error");

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 0, "version only advances on COMMIT");
    // The ALTER that ran before the failure was rolled back too.
    let heartbeat_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('dispatch_contexts') WHERE name = 'last_heartbeat_at'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(heartbeat_columns, 0);
    let messages_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!messages_sql.contains("'heartbeat'"), "messages CHECK untouched after rollback");
}

// ── (e) a genuine upstream-v6 DB climbs the whole post-v6 ladder ──

#[test]
fn v6_database_migrates_to_current() {
    let path = temp_db_path("v6-to-current");
    seed_v6_fixture(&path);

    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 22, "v6 climbs every post-v6 rung");
    assert_master_matches(&dump_master(&conn), &expected_v6_master());
    // The pre-v7 row survives the v9 messages rebuild with its pane identity.
    assert_eq!(
        dump_rows(&conn, "messages", "sequence")
            .iter()
            .map(|row| row.split("|delivery_contract=").next().unwrap().to_string())
            .collect::<Vec<_>>()
            .len(),
        1
    );
    let sender_pane_key: Option<String> = conn
        .query_row("SELECT sender_pane_key FROM messages WHERE id = 'msg_v6'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sender_pane_key.as_deref(), Some("tab_1:leaf_1"));
    drop(conn);

    // Behavioral proof: the fork column landed and round-trips.
    let db = open_orchestration(&path).unwrap();
    let stored = db
        .send_message(&NewMessage {
            id: "msg_after".to_string(),
            from_handle: "coord".to_string(),
            to_handle: "worker-1".to_string(),
            subject: "post-migration".to_string(),
            body: String::new(),
            message_type: "status".to_string(),
            priority: "normal".to_string(),
            thread_id: None,
            payload: None,
            sender_pane_key: None,
            recipient_pane_key: Some("tab_2:leaf_2".to_string()),
        })
        .unwrap();
    assert_eq!(stored.recipient_pane_key.as_deref(), Some("tab_2:leaf_2"));
}

// ── the legacy DATA migrations ──
//
// `orchestration::legacy_compat`'s migration hooks —
// `classify_legacy_message_contracts`, `adopt_legacy_run_if_needed` and
// `backfill_legacy_question_threads` — rewrite pre-v19 ROW state on an upgraded
// database, which the DDL assertions above cannot see. The expected values below
// are the live TS output.

#[test]
fn v1_legacy_data_migrations_match_ts() {
    let path = temp_db_path("v1-legacy-data");
    seed_v1_fixture(&path);
    drop(open_orchestration(&path).unwrap());
    let conn = Connection::open(&path).unwrap();

    // adoptLegacyRunIfNeeded: a real Run absorbs the legacy graph.
    let (adopted_run_id, scheduler_state_lost): (String, i64) = conn
        .query_row(
            "SELECT adopted_run_id, scheduler_state_lost FROM legacy_adoptions WHERE source_run_id = 'run_legacy_local'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(scheduler_state_lost, 1, "a running coordinator with no scheduler is lost state");
    let objective: String = conn
        .query_row("SELECT objective FROM runs WHERE id = ?1", [&adopted_run_id], |r| r.get(0))
        .unwrap();
    assert_eq!(objective, "Recovered orchestration work from a contract update");
    let legacy_objective: String = conn
        .query_row("SELECT objective FROM runs WHERE id = 'run_legacy_local'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(legacy_objective, "Legacy orchestration state (adopted; inspect only)");

    // Every graph row is re-homed onto the adopted Run.
    for (table, id) in [
        ("messages", "msg_a1"),
        ("tasks", "task_a1"),
        ("dispatch_contexts", "ctx_a1"),
        ("decision_gates", "gate_a1"),
    ] {
        let run_id: String = conn
            .query_row(&format!("SELECT run_id FROM {table} WHERE id = '{id}'"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(run_id, adopted_run_id, "{table}.{id} re-homed");
    }

    // classifyLegacyMessageContracts: pre-Run mail is legacy_direct.
    let contracts: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT delivery_contract FROM messages ORDER BY sequence").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert_eq!(contracts, vec!["legacy_direct", "legacy_direct"]);

    // migrateLegacySchedulerLossProvenance: the orphaned coordinator is settled.
    let (status, completed_at, scheduler_lost_at): (String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT status, completed_at, scheduler_lost_at FROM coordinator_runs WHERE id = 'run_a1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(status, "failed");
    assert!(completed_at.is_some(), "settled coordinator is stamped completed");
    assert!(scheduler_lost_at.is_some(), "scheduler loss is recorded as provenance");
}

#[test]
fn v6_legacy_data_migrations_match_ts() {
    let path = temp_db_path("v6-legacy-data");
    seed_v6_fixture(&path);
    drop(open_orchestration(&path).unwrap());
    let conn = Connection::open(&path).unwrap();

    let adopted_run_id: String = conn
        .query_row(
            "SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = 'run_legacy_local'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let (run_id, delivery_contract): (String, String) = conn
        .query_row(
            "SELECT run_id, delivery_contract FROM messages WHERE id = 'msg_v6'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(run_id, adopted_run_id);
    assert_eq!(delivery_contract, "legacy_direct");
}
