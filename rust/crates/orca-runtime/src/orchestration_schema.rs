//! Schema creation + `user_version` migrations for the orchestration DB,
//! ported from `src/main/runtime/orchestration/db.ts` (`createTables` /
//! `migrate`) and `orchestration-schema-version-skew.ts`. SQL strings are
//! byte-copies of the TS template literals (indentation and trailing whitespace
//! included) so the `sqlite_master.sql` text of a Rust-created database matches
//! a TS-created one exactly.

use crate::orchestration::legacy_compat;
use crate::orchestration::run_contract::{CURRENT_CONTRACT_VERSION, LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID};
use orca_store::{Database, StoreError};
use rusqlite::OptionalExtension;

// Why: the ladder follows UPSTREAM numbering (v7 Runs, v8 deliveries, …). The two
// fork-only columns (messages.recipient_pane_key, decision_gates.origin_message_id)
// are deliberately outside it — see `create_fork_pane_identity_columns_if_missing`.
//
// v2 'heartbeat' + last_heartbeat_at, v3 delivered_at, v4 task-creator terminal,
// v5 task_title/display_name, v6 pane identity, v7 lightweight Runs, v8 crash-safe
// Run deliveries, v9 durable question threads, v10 Dispatch capabilities,
// v11 durable mutation receipts, v12 composed worker state, v13 worker runtime
// epoch, v14 federation tables, v15 relay log + import sequences, v16 remote
// questions, v17 attachment protocol version, v18 post-v6 version-skew repair,
// v19 adopted legacy Runs and compatibility receipts, v20 legacy question backfill,
// v21 legacy scheduler-loss provenance, v22 dispatch assignee lookup.
pub(crate) const SCHEMA_VERSION: i64 = 22;

/// Post-v6 `(table, column)` pairs the skew probe requires, from
/// `orchestration-schema-version-skew.ts`.
const POST_V6_COLUMNS: &[(&str, &str)] = &[
    ("messages", "run_id"),
    ("messages", "delivery_contract"),
    ("coordinator_runs", "scheduler_lost_at"),
    ("tasks", "run_id"),
    ("dispatch_contexts", "run_id"),
    ("dispatch_contexts", "contract_version"),
    ("dispatch_contexts", "launch_token_hash"),
    ("dispatch_contexts", "capability_hash"),
    ("dispatch_contexts", "process_incarnation"),
    ("dispatch_contexts", "capability_revoked_at"),
    ("decision_gates", "run_id"),
    ("question_threads", "run_id"),
    ("worker_dispatches", "runtime_epoch"),
    ("federated_dispatches", "to_home_imported_sequence"),
    ("remote_dispatch_attachments", "to_worker_imported_sequence"),
    ("remote_dispatch_attachments", "protocol_version"),
    ("federation_relay_items", "dispatch_id"),
    ("remote_questions", "message_id"),
    ("legacy_adoptions", "source_run_id"),
    ("legacy_compatibility_principals", "id"),
    ("legacy_operation_receipts", "principal_id"),
    ("legacy_mail_receipts", "principal_id"),
];

const POST_V6_INDEXES: &[&str] = &[
    "idx_messages_run_sequence",
    "idx_messages_delivery_contract",
    "idx_tasks_run_status",
    "idx_dispatch_run_status",
    "idx_gates_run_status",
    "idx_runs_coordinator_pane",
    "idx_deliveries_one_outstanding",
    "idx_deliveries_run_created",
    "idx_questions_dispatch_status",
    "idx_federation_relay_pending",
    "idx_remote_questions_dispatch_status",
];

/// Tables that gained `run_id` in the v6 → v7 lightweight-Runs migration.
const RUN_SCOPED_TABLES: &[&str] = &["messages", "tasks", "dispatch_contexts", "decision_gates"];

/// Byte-copy of the db.ts `createTables` exec template. Note what is NOT
/// here: `question_threads` and the four `legacy_*` tables are created only by
/// the migration ladder (v8/v19), exactly as upstream — a fresh DB reaches them
/// because `migrate` always runs from version 0.
const CREATE_TABLES_SQL: &str = r#"
      CREATE TABLE IF NOT EXISTS runs (
        id                    TEXT PRIMARY KEY,
        objective             TEXT NOT NULL,
        home_database         TEXT NOT NULL DEFAULT 'this_database',
        coordinator_handle    TEXT,
        coordinator_pane_key  TEXT,
        consumer_generation   INTEGER NOT NULL DEFAULT 0,
        legacy                INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
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
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
      CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

      CREATE TABLE IF NOT EXISTS deliveries (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL,
        consumer_generation   INTEGER NOT NULL,
        message_ids           TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'outstanding'
          CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_at       TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
        ON deliveries(run_id) WHERE status = 'outstanding';
      CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
        ON deliveries(run_id, created_at);

      CREATE TABLE IF NOT EXISTS mutation_receipts (
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
      );

      CREATE TABLE IF NOT EXISTS worker_dispatches (
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
      );

      CREATE TABLE IF NOT EXISTS federated_dispatches (
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
      );

      CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
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
      );

      CREATE TABLE IF NOT EXISTS federation_relay_items (
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
      );

      CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
        ON federation_relay_items(dispatch_id, direction, acked_at, sequence);

      CREATE TABLE IF NOT EXISTS remote_questions (
        message_id        TEXT PRIMARY KEY,
        dispatch_id       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'answered', 'closed')),
        answer_message_id TEXT,
        answer_body       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
        ON remote_questions(dispatch_id, status);

      CREATE TABLE IF NOT EXISTS tasks (
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
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE IF NOT EXISTS dispatch_contexts (
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
      );

      CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_contexts(task_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_contexts(status);
      CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle);

      CREATE TABLE IF NOT EXISTS decision_gates (
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
      );

      CREATE INDEX IF NOT EXISTS idx_gates_task ON decision_gates(task_id);
      CREATE INDEX IF NOT EXISTS idx_gates_status ON decision_gates(status);

      CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane_leaf
        ON runs(substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1))
        WHERE coordinator_pane_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT,
        scheduler_lost_at   TEXT
      );
    "#;

/// Byte-copy of the db.ts v1 → v2 messages-table rebuild exec template
/// (widens the type CHECK to include 'heartbeat' and adds `delivered_at` in
/// the same rewrite; recreates the indexes DROP TABLE removed).
const MESSAGES_HEARTBEAT_REBUILD_SQL: &str = r#"
            CREATE TABLE messages_new (
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
            );
            INSERT INTO messages_new (
              id, from_handle, to_handle, subject, body, type, priority,
              thread_id, payload, read, sequence, created_at
            )
            SELECT
              id, from_handle, to_handle, subject, body, type, priority,
              thread_id, payload, read, sequence, created_at
            FROM messages;
            DROP TABLE messages;
            ALTER TABLE messages_new RENAME TO messages;

            CREATE UNIQUE INDEX idx_messages_id ON messages(id);
            CREATE INDEX idx_inbox ON messages(to_handle, read);
            CREATE INDEX idx_messages_undelivered_inbox
              ON messages(to_handle, read, delivered_at, sequence);
            CREATE INDEX idx_thread ON messages(thread_id);
          "#;

/// Byte-copy of the db.ts v6 → v7 run-scope index block.
const RUN_SCOPE_INDEXES_SQL: &str = r#"
          CREATE INDEX IF NOT EXISTS idx_messages_run_sequence ON messages(run_id, sequence);
          CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_dispatch_run_status ON dispatch_contexts(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_gates_run_status ON decision_gates(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane ON runs(coordinator_pane_key);
        "#;

/// Byte-copy of the db.ts v7 → v8 block (crash-safe Run deliveries + durable
/// question threads).
const DELIVERIES_AND_QUESTION_THREADS_SQL: &str = r#"
          CREATE TABLE IF NOT EXISTS deliveries (
            id                    TEXT PRIMARY KEY,
            run_id                TEXT NOT NULL,
            consumer_generation   INTEGER NOT NULL,
            message_ids           TEXT NOT NULL,
            status                TEXT NOT NULL DEFAULT 'outstanding'
              CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
            created_at            TEXT NOT NULL DEFAULT (datetime('now')),
            acknowledged_at       TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
            ON deliveries(run_id) WHERE status = 'outstanding';
      CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
        ON deliveries(run_id, created_at);

      CREATE TABLE IF NOT EXISTS question_threads (
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
      );

      CREATE INDEX IF NOT EXISTS idx_questions_dispatch_status
        ON question_threads(dispatch_id, status);
        "#;

/// Byte-copy of the db.ts v8 → v9 messages rebuild that widens the type CHECK
/// to include 'question'.
const MESSAGES_QUESTION_REBUILD_SQL: &str = r#"
          CREATE TABLE messages_new (
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
          );
          INSERT INTO messages_new (
            id, run_id, from_handle, to_handle, subject, body, type, priority,
            thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
          )
          SELECT
            id, run_id, from_handle, to_handle, subject, body, type, priority,
            thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
          FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;

          CREATE UNIQUE INDEX idx_messages_id ON messages(id);
          CREATE INDEX idx_inbox ON messages(to_handle, read);
          CREATE INDEX idx_thread ON messages(thread_id);
          CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence);
          CREATE INDEX idx_messages_undelivered_inbox
            ON messages(to_handle, read, delivered_at, sequence);
        "#;

/// Byte-copy of the db.ts v10 → v11 durable mutation-receipt table.
const MUTATION_RECEIPTS_SQL: &str = r#"
          CREATE TABLE IF NOT EXISTS mutation_receipts (
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
          );
        "#;

/// Byte-copy of the db.ts v11 → v12 composed worker-dispatch state table.
const WORKER_DISPATCHES_SQL: &str = r#"
          CREATE TABLE IF NOT EXISTS worker_dispatches (
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
          );
        "#;

/// Byte-copy of the db.ts v13 → v14 federation tables (home-side federated
/// dispatches + worker-side remote attachments).
const FEDERATED_DISPATCH_TABLES_SQL: &str = r#"
          CREATE TABLE IF NOT EXISTS federated_dispatches (
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
          );
          CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
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
          );
        "#;

/// Byte-copy of the db.ts v14 → v15 federation relay log.
const FEDERATION_RELAY_ITEMS_SQL: &str = r#"
          CREATE TABLE IF NOT EXISTS federation_relay_items (
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
          );
          CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
            ON federation_relay_items(dispatch_id, direction, acked_at, sequence);
        "#;

/// Byte-copy of the db.ts v15 → v16 worker-side remote question table.
const REMOTE_QUESTIONS_SQL: &str = r#"
          CREATE TABLE IF NOT EXISTS remote_questions (
            message_id        TEXT PRIMARY KEY,
            dispatch_id       TEXT NOT NULL,
            status            TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'answered', 'closed')),
            answer_message_id TEXT,
            answer_body       TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            answered_at       TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
            ON remote_questions(dispatch_id, status);
        "#;

/// Byte-copy of the db.ts v21 → v22 dispatch assignee lookup index.
const DISPATCH_ASSIGNEE_INDEX_SQL: &str = r#"
          CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle
            ON dispatch_contexts(assignee_handle);
        "#;

/// Byte-copy of the db.ts `migrateLegacyContractStorage` DDL exec template
/// (v18 → v19): the delivery-contract index plus the four legacy compatibility
/// tables.
const LEGACY_CONTRACT_TABLES_SQL: &str = r#"
      CREATE INDEX IF NOT EXISTS idx_messages_delivery_contract
        ON messages(run_id, delivery_contract, to_handle, read, sequence);

      CREATE TABLE IF NOT EXISTS legacy_adoptions (
        source_run_id        TEXT PRIMARY KEY,
        adopted_run_id       TEXT UNIQUE NOT NULL,
        scheduler_state_lost INTEGER NOT NULL,
        adopted_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS legacy_compatibility_principals (
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
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_principal_coordinator
        ON legacy_compatibility_principals(run_id)
        WHERE role = 'coordinator';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_principal_dispatch
        ON legacy_compatibility_principals(dispatch_id)
        WHERE role = 'worker';

      CREATE TABLE IF NOT EXISTS legacy_operation_receipts (
        principal_id   TEXT NOT NULL,
        operation_key  TEXT NOT NULL,
        method         TEXT NOT NULL,
        payload_hash   TEXT NOT NULL,
        effect_id      TEXT NOT NULL,
        response_json  TEXT NOT NULL,
        completed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(principal_id, operation_key)
      );

      CREATE TABLE IF NOT EXISTS legacy_mail_receipts (
        principal_id    TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY(principal_id, message_id)
      );
    "#;

// Why: written with \n escapes (not a raw string) because the statement has no
// terminating `;`, so SQLite stores the trailing "\n    " into sqlite_master.sql
// — literal trailing whitespace in source would be fragile.
const UNDELIVERED_INBOX_INDEX_SQL: &str =
    "\n      CREATE INDEX IF NOT EXISTS idx_messages_undelivered_inbox\n        ON messages(to_handle, read, delivered_at, sequence)\n    ";

/// TS `createTables`: idempotent full-schema creation, then the
/// delivered_at-gated inbox index.
pub(crate) fn create_tables(db: &Database) -> Result<(), StoreError> {
    db.exec(CREATE_TABLES_SQL)?;
    create_undelivered_inbox_index_if_possible(db)
}

/// TS `migrate`: incremental `user_version` ladder inside one transaction.
/// `user_version` is bumped only on success; a current-or-future effective
/// version (>= SCHEMA_VERSION) returns immediately and is left untouched.
pub(crate) fn migrate(db: &Database) -> Result<(), StoreError> {
    let stored = db.pragma_i64("user_version")?;
    let current = resolve_migration_start_version(db, stored, SCHEMA_VERSION)?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }
    db.exec("BEGIN IMMEDIATE")?;
    // Why: COMMIT sits inside the fallible path (as in the TS try block), so
    // any failure — including a failed COMMIT — rolls back and the DB stays at
    // the prior version.
    let applied = apply_version_ladder(db, current).and_then(|()| db.exec("COMMIT"));
    if let Err(err) = applied {
        db.exec("ROLLBACK")?;
        return Err(err);
    }
    Ok(())
}

/// TS `createForkPaneIdentityColumnsIfMissing`, run AFTER `migrate` because a
/// pre-v9 upgrade rebuilds the messages table and would drop them.
///
/// Why: these two columns are this fork's, not upstream's, so they stay OUT of the
/// upstream `user_version` ladder — an upstream v23 must be free to mean something
/// else. Repaired on every open, which also reaches an already-at-head DB that
/// `migrate` short-circuits.
pub(crate) fn create_fork_pane_identity_columns_if_missing(db: &Database) -> Result<(), StoreError> {
    // recipient_pane_key: delivery follows the pane once the addressed handle is
    // reminted (#9163). origin_message_id: a gate opened by `ask` must remember the
    // message to answer back through.
    if !has_column(db, "messages", "recipient_pane_key")? {
        db.exec("ALTER TABLE messages ADD COLUMN recipient_pane_key TEXT")?;
    }
    if !has_column(db, "decision_gates", "origin_message_id")? {
        db.exec("ALTER TABLE decision_gates ADD COLUMN origin_message_id TEXT")?;
    }
    Ok(())
}

fn apply_version_ladder(db: &Database, current: i64) -> Result<(), StoreError> {
    // v1 → v2: add last_heartbeat_at; rebuild messages to widen the type CHECK
    // (SQLite cannot ALTER a CHECK constraint). The rebuild also carries the
    // v3 delivered_at column so v1 DBs need only one table rewrite.
    if current < 2 {
        if !has_column(db, "dispatch_contexts", "last_heartbeat_at")? {
            db.exec("ALTER TABLE dispatch_contexts ADD COLUMN last_heartbeat_at TEXT")?;
        }
        if !messages_type_check_allows(db, "'heartbeat'")? {
            db.exec(MESSAGES_HEARTBEAT_REBUILD_SQL)?;
        }
    }
    // v2 → v3: DBs that reached v2 via the rebuild above already have the
    // column; this covers DBs that were at v2 before v3 shipped.
    if current < 3 && !has_column(db, "messages", "delivered_at")? {
        db.exec("ALTER TABLE messages ADD COLUMN delivered_at TEXT")?;
    }
    if current < 4 && !has_column(db, "tasks", "created_by_terminal_handle")? {
        db.exec("ALTER TABLE tasks ADD COLUMN created_by_terminal_handle TEXT")?;
    }
    if current < 5 {
        if !has_column(db, "tasks", "task_title")? {
            db.exec("ALTER TABLE tasks ADD COLUMN task_title TEXT")?;
        }
        if !has_column(db, "tasks", "display_name")? {
            db.exec("ALTER TABLE tasks ADD COLUMN display_name TEXT")?;
        }
    }
    // v5 → v6: pane-identity columns for remint-stable ownership.
    if current < 6 {
        if !has_column(db, "dispatch_contexts", "assignee_pane_key")? {
            db.exec("ALTER TABLE dispatch_contexts ADD COLUMN assignee_pane_key TEXT")?;
        }
        if !has_column(db, "messages", "sender_pane_key")? {
            db.exec("ALTER TABLE messages ADD COLUMN sender_pane_key TEXT")?;
        }
    }
    // v6 → v7: lightweight Runs. Every pre-Run row is adopted by the legacy run.
    if current < 7 {
        db.connection().execute(
            "INSERT OR IGNORE INTO runs (
               id, objective, home_database, consumer_generation, legacy
             ) VALUES (?1, ?2, 'this_database', 0, 1)",
            rusqlite::params![LEGACY_RUN_ID, "Legacy orchestration state (inspect only)"],
        )?;
        for table in RUN_SCOPED_TABLES {
            if !has_column(db, table, "run_id")? {
                db.exec(&format!(
                    "ALTER TABLE {table} ADD COLUMN run_id TEXT NOT NULL DEFAULT '{LEGACY_RUN_ID}'"
                ))?;
            }
        }
        db.exec(RUN_SCOPE_INDEXES_SQL)?;
    }
    if current < 8 {
        db.exec(DELIVERIES_AND_QUESTION_THREADS_SQL)?;
    }
    if current < 9 && !messages_type_check_allows(db, "'question'")? {
        db.exec(MESSAGES_QUESTION_REBUILD_SQL)?;
    }
    // v9 → v10: Dispatch capability columns.
    if current < 10 {
        if !has_column(db, "dispatch_contexts", "capability_hash")? {
            db.exec("ALTER TABLE dispatch_contexts ADD COLUMN capability_hash TEXT")?;
        }
        if !has_column(db, "dispatch_contexts", "process_incarnation")? {
            db.exec("ALTER TABLE dispatch_contexts ADD COLUMN process_incarnation TEXT")?;
        }
        if !has_column(db, "dispatch_contexts", "capability_revoked_at")? {
            db.exec("ALTER TABLE dispatch_contexts ADD COLUMN capability_revoked_at TEXT")?;
        }
    }
    if current < 11 {
        db.exec(MUTATION_RECEIPTS_SQL)?;
    }
    if current < 12 {
        db.exec(WORKER_DISPATCHES_SQL)?;
    }
    if current < 13 && !has_column(db, "worker_dispatches", "runtime_epoch")? {
        db.exec("ALTER TABLE worker_dispatches ADD COLUMN runtime_epoch TEXT")?;
    }
    if current < 14 {
        db.exec(FEDERATED_DISPATCH_TABLES_SQL)?;
    }
    if current < 15 {
        if !has_column(db, "federated_dispatches", "to_home_imported_sequence")? {
            db.exec(
                "ALTER TABLE federated_dispatches ADD COLUMN to_home_imported_sequence INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        if !has_column(db, "remote_dispatch_attachments", "to_worker_imported_sequence")? {
            db.exec(
                "ALTER TABLE remote_dispatch_attachments ADD COLUMN to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        db.exec(FEDERATION_RELAY_ITEMS_SQL)?;
    }
    if current < 16 {
        db.exec(REMOTE_QUESTIONS_SQL)?;
    }
    if current < 17 && !has_column(db, "remote_dispatch_attachments", "protocol_version")? {
        db.exec(
            "ALTER TABLE remote_dispatch_attachments ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1",
        )?;
    }
    if current < 19 {
        migrate_legacy_contract_storage(db)?;
    }
    if current < 20 {
        legacy_compat::backfill_legacy_question_threads(db)?;
    }
    if current < 21 {
        migrate_legacy_scheduler_loss_provenance(db)?;
    }
    if current < 22 {
        db.exec(DISPATCH_ASSIGNEE_INDEX_SQL)?;
    }
    create_undelivered_inbox_index_if_possible(db)?;
    db.exec(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
}

/// TS `migrateLegacyContractStorage` (v18 → v19).
fn migrate_legacy_contract_storage(db: &Database) -> Result<(), StoreError> {
    if !has_column(db, "dispatch_contexts", "contract_version")? {
        db.exec(&format!(
            "ALTER TABLE dispatch_contexts
         ADD COLUMN contract_version INTEGER NOT NULL DEFAULT {CURRENT_CONTRACT_VERSION}"
        ))?;
    }
    if !has_column(db, "dispatch_contexts", "launch_token_hash")? {
        db.exec("ALTER TABLE dispatch_contexts ADD COLUMN launch_token_hash TEXT")?;
    }
    if !has_column(db, "messages", "delivery_contract")? {
        db.exec(
            "ALTER TABLE messages
         ADD COLUMN delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
         CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only'))",
        )?;
    }
    db.exec(LEGACY_CONTRACT_TABLES_SQL)?;
    db.connection().execute(
        "UPDATE dispatch_contexts
         SET contract_version = ?1
         WHERE run_id = ?2 AND capability_hash IS NULL",
        rusqlite::params![LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID],
    )?;
    legacy_compat::classify_legacy_message_contracts(db, LEGACY_RUN_ID, false)?;
    ensure_legacy_scheduler_loss_column(db)?;
    legacy_compat::adopt_legacy_run_if_needed(db)
}

/// TS `migrateLegacySchedulerLossProvenance` (v20 → v21).
fn migrate_legacy_scheduler_loss_provenance(db: &Database) -> Result<(), StoreError> {
    ensure_legacy_scheduler_loss_column(db)?;
    legacy_compat::adopt_legacy_run_if_needed(db)?;
    if let Some(adopted_run_id) = legacy_compat::adopted_legacy_run_id(db)? {
        legacy_compat::classify_legacy_message_contracts(db, &adopted_run_id, true)?;
    }
    Ok(())
}

/// TS `ensureLegacySchedulerLossColumn`.
fn ensure_legacy_scheduler_loss_column(db: &Database) -> Result<(), StoreError> {
    if !has_column(db, "coordinator_runs", "scheduler_lost_at")? {
        db.exec("ALTER TABLE coordinator_runs ADD COLUMN scheduler_lost_at TEXT")?;
    }
    Ok(())
}

fn create_undelivered_inbox_index_if_possible(db: &Database) -> Result<(), StoreError> {
    if !has_column(db, "messages", "delivered_at")? {
        return Ok(());
    }
    db.exec(UNDELIVERED_INBOX_INDEX_SQL)
}

/// Port of `resolveOrchestrationMigrationStartVersion`.
///
/// Why: this fork's Rust store shipped its own v6/v7/v8 meanings, and pre-Run
/// upstream DBs could also claim the post-v6 range while retaining v6 tables. A
/// stored version is only trusted when the post-v6 schema is actually complete;
/// otherwise the ladder replays from 6.
fn resolve_migration_start_version(
    db: &Database,
    stored_version: i64,
    schema_version: i64,
) -> Result<i64, StoreError> {
    if stored_version > schema_version {
        return Ok(stored_version);
    }
    if has_complete_post_v6_schema(db)? {
        return Ok(stored_version);
    }
    Ok(stored_version.min(schema_version).min(6))
}

fn has_complete_post_v6_schema(db: &Database) -> Result<bool, StoreError> {
    // Why: short-circuit in the TS order — has_consistent_legacy_adoption queries
    // tables that only exist once every column probe above has passed.
    for (table, column) in POST_V6_COLUMNS {
        if !has_column(db, table, column)? {
            return Ok(false);
        }
    }
    for index in POST_V6_INDEXES {
        if !has_index(db, index)? {
            return Ok(false);
        }
    }
    if !messages_type_check_allows(db, "'question'")? {
        return Ok(false);
    }
    has_consistent_legacy_adoption(db)
}

/// Port of `hasConsistentLegacyAdoption`: the legacy run must be either empty and
/// unadopted, or adopted into a real (non-legacy) run.
fn has_consistent_legacy_adoption(db: &Database) -> Result<bool, StoreError> {
    let conn = db.connection();
    let source_graph: Option<i64> = conn
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
    if source_graph.is_some() {
        return Ok(false);
    }
    let adopted: Option<String> = conn
        .query_row(
            "SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = ?1",
            [LEGACY_RUN_ID],
            |row| row.get(0),
        )
        .optional()?;
    let Some(adopted) = adopted else {
        return Ok(true);
    };
    let live: Option<i64> = conn
        .query_row("SELECT 1 FROM runs WHERE id = ?1 AND legacy = 0", [adopted], |row| row.get(0))
        .optional()?;
    Ok(live.is_some())
}

fn has_column(db: &Database, table: &str, column: &str) -> Result<bool, StoreError> {
    let conn = db.connection();
    // Why: table name interpolated, not bound — PRAGMA takes no parameters
    // (same as the TS hasColumn); callers only pass fixed schema names.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get("name")?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn has_index(db: &Database, index: &str) -> Result<bool, StoreError> {
    let found: Option<i64> = db
        .connection()
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1",
            [index],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

// Why: sqlite_master keeps the original CREATE TABLE text including the CHECK
// clause; inspecting it is the cheapest reliable pre-rebuild probe (same as TS).
fn messages_type_check_allows(db: &Database, quoted_type: &str) -> Result<bool, StoreError> {
    let sql: Option<Option<String>> = db
        .connection()
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(sql.flatten().is_some_and(|s| s.contains(quoted_type)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_column_probes_existing_and_missing_columns() {
        let db = Database::open_in_memory().unwrap();
        db.exec("CREATE TABLE probe (alpha TEXT, beta INTEGER)").unwrap();
        assert!(has_column(&db, "probe", "alpha").unwrap());
        assert!(has_column(&db, "probe", "beta").unwrap());
        assert!(!has_column(&db, "probe", "gamma").unwrap());
        // Missing table → empty table_info → false (mirrors TS).
        assert!(!has_column(&db, "no_such_table", "alpha").unwrap());
    }

    #[test]
    fn heartbeat_probe_reads_check_text_from_sqlite_master() {
        let db = Database::open_in_memory().unwrap();
        // No messages table at all → false.
        assert!(!messages_type_check_allows(&db, "'heartbeat'").unwrap());
        db.exec("CREATE TABLE messages (type TEXT CHECK(type IN ('status')))").unwrap();
        assert!(!messages_type_check_allows(&db, "'heartbeat'").unwrap());
        db.exec("DROP TABLE messages").unwrap();
        db.exec("CREATE TABLE messages (type TEXT CHECK(type IN ('status', 'heartbeat')))")
            .unwrap();
        assert!(messages_type_check_allows(&db, "'heartbeat'").unwrap());
        assert!(!messages_type_check_allows(&db, "'question'").unwrap());
    }

    #[test]
    fn fresh_database_lands_on_current_schema_version() {
        let db = Database::open_in_memory().unwrap();
        create_tables(&db).unwrap();
        migrate(&db).unwrap();
        create_fork_pane_identity_columns_if_missing(&db).unwrap();
        assert_eq!(db.pragma_i64("user_version").unwrap(), SCHEMA_VERSION);
        // Idempotent: a second migrate is a no-op.
        migrate(&db).unwrap();
        assert_eq!(db.pragma_i64("user_version").unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn fresh_database_creates_every_orchestration_table() {
        let db = Database::open_in_memory().unwrap();
        create_tables(&db).unwrap();
        migrate(&db).unwrap();
        for table in [
            "runs",
            "messages",
            "deliveries",
            "mutation_receipts",
            "worker_dispatches",
            "federated_dispatches",
            "remote_dispatch_attachments",
            "federation_relay_items",
            "remote_questions",
            "question_threads",
            "tasks",
            "dispatch_contexts",
            "decision_gates",
            "coordinator_runs",
            "legacy_adoptions",
            "legacy_compatibility_principals",
            "legacy_operation_receipts",
            "legacy_mail_receipts",
        ] {
            let found: Option<i64> = db
                .connection()
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .optional()
                .unwrap();
            assert!(found.is_some(), "missing table {table}");
        }
    }

    #[test]
    fn fresh_database_has_the_complete_post_v6_schema() {
        let db = Database::open_in_memory().unwrap();
        create_tables(&db).unwrap();
        migrate(&db).unwrap();
        // Every skew-probe column and index must be present, else a reopened DB
        // would be dragged back to version 6 forever.
        assert!(has_complete_post_v6_schema(&db).unwrap());
        assert_eq!(resolve_migration_start_version(&db, SCHEMA_VERSION, SCHEMA_VERSION).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn skewed_pre_run_database_replays_from_version_six() {
        let db = Database::open_in_memory().unwrap();
        // A fork DB that claimed v8 under the OLD (fork) numbering has none of the
        // post-v6 upstream schema; the resolver must drag it back to 6.
        db.exec("CREATE TABLE messages (id TEXT, type TEXT CHECK(type IN ('status')))").unwrap();
        assert_eq!(resolve_migration_start_version(&db, 8, SCHEMA_VERSION).unwrap(), 6);
    }
}
