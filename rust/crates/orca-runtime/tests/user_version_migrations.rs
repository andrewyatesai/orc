//! Golden tests for the `user_version` migration ladder against live TS
//! behavior. The expected `sqlite_master` texts, row dumps, and versions below
//! were captured from `src/main/runtime/orchestration/db.ts` running under
//! node:sqlite (temporary vitest harness, since deleted); the Rust port must
//! reproduce them byte-for-byte.

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

// ── goldens: sqlite_master sql text captured from the TS implementation ──

const GATES_SQL: &str = r#"CREATE TABLE decision_gates (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'resolved', 'timeout')),
        resolution    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT,
        origin_message_id TEXT,
        run_id        TEXT,
        category      TEXT,
        default_option TEXT,
        manager_deadline_at TEXT,
        hard_deadline_at TEXT,
        policy_snapshot TEXT,
        resolved_by   TEXT,
        resolution_reason TEXT,
        version       INTEGER NOT NULL DEFAULT 0
      )"#;

/// Same table reached via the v7 -> v8 ALTER: SQLite appends the column to the
/// stored CREATE text rather than rewriting it, so the fresh and migrated SQL differ.
const GATES_MIGRATED_SQL: &str = r#"CREATE TABLE decision_gates (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'resolved', 'timeout')),
        resolution    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT
      , origin_message_id TEXT, run_id TEXT, category TEXT, default_option TEXT, manager_deadline_at TEXT, hard_deadline_at TEXT, policy_snapshot TEXT, resolved_by TEXT, resolution_reason TEXT, version INTEGER NOT NULL DEFAULT 0)"#;

const RUNS_SQL: &str = r#"CREATE TABLE coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT,
        gate_resolution_policy TEXT NOT NULL DEFAULT 'human-only',
        gate_category_allowlist TEXT NOT NULL DEFAULT '[]'
      )"#;

const MESSAGES_FRESH_SQL: &str = r#"CREATE TABLE messages (
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
        sender_pane_key TEXT,
        recipient_pane_key TEXT
      )"#;

const TASKS_FRESH_SQL: &str = r#"CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
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
        completed_at  TEXT,
        run_id        TEXT
      )"#;

const DISPATCH_FRESH_SQL: &str = r#"CREATE TABLE dispatch_contexts (
        id                  TEXT PRIMARY KEY,
        task_id             TEXT NOT NULL,
        assignee_handle     TEXT,
        assignee_pane_key   TEXT,
        status              TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'dispatched', 'waiting_gate', 'completed', 'failed', 'circuit_broken')),
        failure_count       INTEGER NOT NULL DEFAULT 0,
        last_failure        TEXT,
        dispatched_at       TEXT,
        completed_at        TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at   TEXT,
        run_id              TEXT,
        contract_version    INTEGER NOT NULL DEFAULT 1,
        launch_token_hash   TEXT,
        capability_hash     TEXT,
        process_incarnation TEXT,
        capability_revoked_at TEXT
      )"#;

// Why: the TS index template has no terminating `;`, so SQLite stores its
// trailing "\n    " into sqlite_master.sql — built with concat! to avoid
// literal trailing whitespace in source.
const UNDELIVERED_IDX_FRESH_SQL: &str = concat!(
    "CREATE INDEX idx_messages_undelivered_inbox\n",
    "        ON messages(to_handle, read, delivered_at, sequence)\n",
    "    "
);

// After the v1 → v2 rebuild, the same index comes from the migration exec
// block (different indentation, `;`-terminated).
const UNDELIVERED_IDX_REBUILD_SQL: &str = concat!(
    "CREATE INDEX idx_messages_undelivered_inbox\n",
    "              ON messages(to_handle, read, delivered_at, sequence)"
);

// ALTER TABLE RENAME rewrites the stored text with the quoted new name.
const MESSAGES_MIGRATED_SQL: &str = r#"CREATE TABLE "messages" (
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
              delivered_at  TEXT
            , sender_pane_key TEXT, recipient_pane_key TEXT)"#;

// ALTER TABLE ADD COLUMN appends `, <col> ...` before the closing paren.
const TASKS_MIGRATED_SQL: &str = r#"CREATE TABLE tasks (
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
      , created_by_terminal_handle TEXT, task_title TEXT, display_name TEXT, run_id TEXT)"#;

/// v9 REBUILDS this table (SQLite cannot widen the status CHECK in place), so unlike every
/// other migrated table its stored text is the rebuild's — quoted name, rebuild indentation.
/// That is the visible proof the rebuild ran rather than an ALTER. The v10 capability
/// columns then land via ALTER, appended before the closing paren.
const DISPATCH_MIGRATED_SQL: &str = r#"CREATE TABLE "dispatch_contexts" (
              id                  TEXT PRIMARY KEY,
              task_id             TEXT NOT NULL,
              assignee_handle     TEXT,
              assignee_pane_key   TEXT,
              status              TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending', 'dispatched', 'waiting_gate', 'completed', 'failed', 'circuit_broken')),
              failure_count       INTEGER NOT NULL DEFAULT 0,
              last_failure        TEXT,
              dispatched_at       TEXT,
              completed_at        TEXT,
              created_at          TEXT NOT NULL DEFAULT (datetime('now')),
              last_heartbeat_at   TEXT,
              run_id              TEXT
            , contract_version INTEGER NOT NULL DEFAULT 1, launch_token_hash TEXT, capability_hash TEXT, process_incarnation TEXT, capability_revoked_at TEXT)"#;

/// coordinator_runs reaches v9 by ALTER, so its two policy columns are appended.
const RUNS_MIGRATED_SQL: &str = r#"CREATE TABLE coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT
      , gate_resolution_policy TEXT NOT NULL DEFAULT 'human-only', gate_category_allowlist TEXT NOT NULL DEFAULT '[]')"#;

type MasterEntry = (&'static str, &'static str, Option<&'static str>);

/// `SELECT type, name, sql FROM sqlite_master ORDER BY name` of a TS-fresh DB.
// ── v9 objects ──

const AUDIT_SQL: &str = r#"CREATE TABLE audit_events (
        id              TEXT PRIMARY KEY,
        run_id          TEXT,
        actor           TEXT NOT NULL,
        action          TEXT NOT NULL,
        target_pane_key TEXT,
        target_handle   TEXT,
        evidence_ref    TEXT,
        detail          TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )"#;

const ROTATION_SQL: &str = r#"CREATE TABLE rotation_sagas (
        id                      TEXT PRIMARY KEY,
        provider                TEXT NOT NULL,
        phase                   TEXT NOT NULL DEFAULT 'planned',
        source_route_key        TEXT,
        target_route_key        TEXT NOT NULL,
        target_store_key        TEXT,
        reservation_fence       INTEGER NOT NULL DEFAULT 0,
        reservation_expires_at  TEXT NOT NULL,
        reservation_released_at TEXT,
        last_error              TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT
      )"#;

const ROTATION_PROVIDER_IDX_SQL: &str = "CREATE INDEX idx_rotation_provider\n        ON rotation_sagas(provider, reservation_released_at)";
const ROTATION_ROUTE_IDX_SQL: &str = "CREATE UNIQUE INDEX idx_rotation_target_route\n        ON rotation_sagas(target_route_key) WHERE reservation_released_at IS NULL";
const ROTATION_STORE_IDX_SQL: &str = "CREATE UNIQUE INDEX idx_rotation_target_store\n        ON rotation_sagas(target_store_key) WHERE reservation_released_at IS NULL";
const ONE_PENDING_GATE_IDX_SQL: &str = "CREATE UNIQUE INDEX idx_gates_one_pending_per_task ON decision_gates(task_id) WHERE status = 'pending'";

const AUDIT_APPEND_ONLY_TRIGGER_SQL: &str = r#"CREATE TRIGGER trg_audit_events_append_only
        BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only');
      END"#;

/// The v9 downgrade fence: a v8 binary knows only 'pending'/'dispatched', so it would
/// read a pane parked in `waiting_gate` as free. SQLite refuses the second dispatch.
const WAITING_GATE_FENCE_TRIGGER_SQL: &str = r#"CREATE TRIGGER trg_dispatch_waiting_gate_fence
        BEFORE INSERT ON dispatch_contexts
        WHEN EXISTS (
          SELECT 1 FROM dispatch_contexts d
          WHERE d.status = 'waiting_gate'
            AND (d.assignee_handle = NEW.assignee_handle
              OR d.assignee_pane_key = NEW.assignee_pane_key)
        )
      BEGIN
        SELECT RAISE(ABORT, 'assignee is parked in waiting_gate: refusing a second dispatch (schema v9)');
      END"#;

fn expected_fresh_master() -> Vec<MasterEntry> {
    vec![
        ("table", "audit_events", Some(AUDIT_SQL)),
        ("table", "coordinator_runs", Some(RUNS_SQL)),
        ("table", "decision_gates", Some(GATES_SQL)),
        ("table", "dispatch_contexts", Some(DISPATCH_FRESH_SQL)),
        ("index", "idx_audit_run", Some("CREATE INDEX idx_audit_run ON audit_events(run_id)")),
        ("index", "idx_dispatch_status", Some("CREATE INDEX idx_dispatch_status ON dispatch_contexts(status)")),
        ("index", "idx_dispatch_task", Some("CREATE INDEX idx_dispatch_task ON dispatch_contexts(task_id)")),
        ("index", "idx_gates_one_pending_per_task", Some(ONE_PENDING_GATE_IDX_SQL)),
        ("index", "idx_gates_run", Some("CREATE INDEX idx_gates_run ON decision_gates(run_id)")),
        ("index", "idx_gates_status", Some("CREATE INDEX idx_gates_status ON decision_gates(status)")),
        ("index", "idx_gates_task", Some("CREATE INDEX idx_gates_task ON decision_gates(task_id)")),
        ("index", "idx_inbox", Some("CREATE INDEX idx_inbox ON messages(to_handle, read)")),
        ("index", "idx_messages_id", Some("CREATE UNIQUE INDEX idx_messages_id ON messages(id)")),
        ("index", "idx_messages_undelivered_inbox", Some(UNDELIVERED_IDX_FRESH_SQL)),
        ("index", "idx_rotation_provider", Some(ROTATION_PROVIDER_IDX_SQL)),
        ("index", "idx_rotation_target_route", Some(ROTATION_ROUTE_IDX_SQL)),
        ("index", "idx_rotation_target_store", Some(ROTATION_STORE_IDX_SQL)),
        ("index", "idx_tasks_parent", Some("CREATE INDEX idx_tasks_parent ON tasks(parent_id)")),
        ("index", "idx_tasks_run", Some("CREATE INDEX idx_tasks_run ON tasks(run_id)")),
        ("index", "idx_tasks_status", Some("CREATE INDEX idx_tasks_status ON tasks(status)")),
        ("index", "idx_thread", Some("CREATE INDEX idx_thread ON messages(thread_id)")),
        ("table", "messages", Some(MESSAGES_FRESH_SQL)),
        ("table", "rotation_sagas", Some(ROTATION_SQL)),
        ("index", "sqlite_autoindex_audit_events_1", None),
        ("index", "sqlite_autoindex_coordinator_runs_1", None),
        ("index", "sqlite_autoindex_decision_gates_1", None),
        ("index", "sqlite_autoindex_dispatch_contexts_1", None),
        ("index", "sqlite_autoindex_rotation_sagas_1", None),
        ("index", "sqlite_autoindex_tasks_1", None),
        ("table", "sqlite_sequence", Some("CREATE TABLE sqlite_sequence(name,seq)")),
        ("table", "tasks", Some(TASKS_FRESH_SQL)),
        ("trigger", "trg_audit_events_append_only", Some(AUDIT_APPEND_ONLY_TRIGGER_SQL)),
        ("trigger", "trg_dispatch_waiting_gate_fence", Some(WAITING_GATE_FENCE_TRIGGER_SQL)),
    ]
}

/// Same dump of the v1 fixture DB after the TS constructor migrated it to v5.
fn expected_migrated_v1_master() -> Vec<MasterEntry> {
    let mut master = expected_fresh_master();
    for entry in &mut master {
        entry.2 = match entry.1 {
            "coordinator_runs" => Some(RUNS_MIGRATED_SQL),
            "decision_gates" => Some(GATES_MIGRATED_SQL),
            "dispatch_contexts" => Some(DISPATCH_MIGRATED_SQL),
            "idx_messages_undelivered_inbox" => Some(UNDELIVERED_IDX_REBUILD_SQL),
            "messages" => Some(MESSAGES_MIGRATED_SQL),
            "tasks" => Some(TASKS_MIGRATED_SQL),
            _ => entry.2,
        };
    }
    master
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

// ── (a) fresh open ──

#[test]
fn fresh_open_matches_ts_fresh_database() {
    let path = temp_db_path("fresh");
    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 10, "fresh DB lands on SCHEMA_VERSION");
    let journal: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)).unwrap();
    assert_eq!(journal, "wal", "journal_mode=WAL persists in the DB file");
    assert_master_matches(&dump_master(&conn), &expected_fresh_master());
}

// ── (b) v1 fixture migrates to current with data preserved ──

#[test]
fn v1_database_migrates_to_current_preserving_data() {
    let path = temp_db_path("v1-migrate");
    {
        let fixture = Connection::open(&path).unwrap();
        fixture.execute_batch(V1_SCHEMA_SQL).unwrap();
        fixture.execute_batch(V1_SEED_SQL).unwrap();
        // v1 code never wrote user_version — leave it at 0.
        assert_eq!(user_version(&fixture), 0);
    }

    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 10);
    assert_master_matches(&dump_master(&conn), &expected_migrated_v1_master());

    // Row-level goldens from the TS-migrated fixture.
    assert_eq!(
        dump_rows(&conn, "messages", "sequence"),
        vec![
            r#"id=msg_a1|from_handle=coordinator|to_handle=worker-1|subject=first|body=body one|type=dispatch|priority=high|thread_id=thread-1|payload={"k":1}|read=1|sequence=1|created_at=2025-01-02 03:04:05|delivered_at=NULL|sender_pane_key=NULL|recipient_pane_key=NULL"#,
            "id=msg_a2|from_handle=worker-1|to_handle=coordinator|subject=second|body=|type=status|priority=normal|thread_id=NULL|payload=NULL|read=0|sequence=2|created_at=2025-01-02 03:04:06|delivered_at=NULL|sender_pane_key=NULL|recipient_pane_key=NULL",
        ]
    );
    assert_eq!(
        dump_rows(&conn, "tasks", "id"),
        vec![
            "id=task_a1|parent_id=NULL|spec=build the thing|status=completed|deps=[]|result=done|created_at=2025-01-02 03:00:00|completed_at=2025-01-02 04:00:00|created_by_terminal_handle=NULL|task_title=NULL|display_name=NULL|run_id=NULL",
            r#"id=task_a2|parent_id=task_a1|spec=test the thing|status=pending|deps=["task_a1"]|result=NULL|created_at=2025-01-02 03:00:01|completed_at=NULL|created_by_terminal_handle=NULL|task_title=NULL|display_name=NULL|run_id=NULL"#,
        ]
    );
    assert_eq!(
        dump_rows(&conn, "dispatch_contexts", "id"),
        vec![
            // v9 REBUILT this table, so assignee_pane_key sits where a fresh schema puts it
            // rather than where the v6 ALTER appended it: same data, fresh column order.
            // contract_version=0: the v10 backfill marks every pre-capability row LEGACY.
            "id=ctx_a1|task_id=task_a1|assignee_handle=worker-1|assignee_pane_key=NULL|status=completed|failure_count=1|last_failure=flaky once|dispatched_at=2025-01-02 03:10:00|completed_at=2025-01-02 04:00:00|created_at=2025-01-02 03:10:00|last_heartbeat_at=NULL|run_id=NULL|contract_version=0|launch_token_hash=NULL|capability_hash=NULL|process_incarnation=NULL|capability_revoked_at=NULL",
        ]
    );
    assert_eq!(
        dump_rows(&conn, "decision_gates", "id"),
        vec![
            // origin_message_id=NULL: a gate written before v8 has no ask to answer, so the
            // resolve path skips the thread reply and behaves exactly as it did pre-migration.
            r#"id=gate_a1|task_id=task_a1|question=Proceed?|options=["yes","no"]|status=resolved|resolution=yes|created_at=2025-01-02 03:20:00|resolved_at=2025-01-02 03:25:00|origin_message_id=NULL|run_id=NULL|category=NULL|default_option=NULL|manager_deadline_at=NULL|hard_deadline_at=NULL|policy_snapshot=NULL|resolved_by=NULL|resolution_reason=NULL|version=0"#,
        ]
    );
    assert_eq!(
        dump_rows(&conn, "coordinator_runs", "id"),
        vec![
            "id=run_a1|spec=orchestrate|status=running|coordinator_handle=coordinator|poll_interval_ms=2000|created_at=2025-01-02 03:00:00|completed_at=NULL|gate_resolution_policy=human-only|gate_category_allowlist=[]",
        ]
    );
    assert_eq!(dump_rows(&conn, "sqlite_sequence", "name"), vec!["name=messages|seq=2"]);
    drop(conn);

    // Behavioral proof the widened CHECK took: 'heartbeat' inserts now pass.
    let db = open_orchestration(&path).unwrap();
    db.send_message(&NewMessage {
        id: "msg_hb".to_string(),
        from_handle: "worker-1".to_string(),
        to_handle: "coordinator".to_string(),
        subject: "hb".to_string(),
        body: String::new(),
        message_type: "heartbeat".to_string(),
        priority: "normal".to_string(),
        thread_id: None,
        payload: None,
        sender_pane_key: None,
        recipient_pane_key: None,
    })
    .unwrap();
}

// ── (c) already-current open is a no-op ──

#[test]
fn already_current_open_is_a_noop() {
    let path = temp_db_path("noop");
    {
        let db = open_orchestration(&path).unwrap();
        db.create_task("t1", "spec one", None, &[], Some("term-1"), None, None, None).unwrap();
    }
    let (version_before, master_before, tasks_before) = {
        let conn = Connection::open(&path).unwrap();
        (user_version(&conn), dump_master(&conn), dump_rows(&conn, "tasks", "id"))
    };
    assert_eq!(version_before, 10);

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
    // Captured from TS: the future-version dump equals the fresh dump.
    assert_master_matches(&dump_master(&conn), &expected_fresh_master());
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

// ── (e) v6 → v7 ladder row: recipient_pane_key lands via ALTER, data intact ──

#[test]
fn v6_database_migrates_to_v7_adding_recipient_pane_key() {
    let path = temp_db_path("v6-to-v7");
    {
        // A v6 DB is the current fresh schema minus recipient_pane_key.
        let fixture = Connection::open(&path).unwrap();
        fixture
            .execute_batch(&format!(
                "{};\nPRAGMA user_version = 6;",
                MESSAGES_FRESH_SQL.replace(",\n        recipient_pane_key TEXT", "")
            ))
            .unwrap();
        fixture
            .execute_batch(
                "INSERT INTO messages (id, from_handle, to_handle, subject, sender_pane_key, created_at)
                 VALUES ('msg_v6', 'coord', 'worker-1', 'pre-v7', 'tab_1:leaf_1', '2025-01-02 03:04:05')",
            )
            .unwrap();
    }

    drop(open_orchestration(&path).unwrap());

    let conn = Connection::open(&path).unwrap();
    assert_eq!(user_version(&conn), 10, "v6 ladder row advances through v10");
    let messages_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // ALTER TABLE ADD COLUMN appends before the closing paren.
    assert!(messages_sql.ends_with(", recipient_pane_key TEXT)"), "column added via ALTER: {messages_sql}");
    assert_eq!(
        dump_rows(&conn, "messages", "sequence"),
        vec![
            "id=msg_v6|from_handle=coord|to_handle=worker-1|subject=pre-v7|body=|type=status|priority=normal|thread_id=NULL|payload=NULL|read=0|sequence=1|created_at=2025-01-02 03:04:05|delivered_at=NULL|sender_pane_key=tab_1:leaf_1|recipient_pane_key=NULL",
        ]
    );
    drop(conn);

    // Behavioral proof: the migrated DB persists + returns the new column.
    let db = open_orchestration(&path).unwrap();
    let stored = db
        .send_message(&NewMessage {
            id: "msg_v7".to_string(),
            from_handle: "coord".to_string(),
            to_handle: "worker-1".to_string(),
            subject: "post-v7".to_string(),
            body: String::new(),
            message_type: "status".to_string(),
            priority: "normal".to_string(),
            thread_id: None,
            payload: None,
            sender_pane_key: None,
            recipient_pane_key: Some("tab_1:leaf_1".to_string()),
        })
        .unwrap();
    assert_eq!(stored.recipient_pane_key.as_deref(), Some("tab_1:leaf_1"));
}
