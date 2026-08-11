//! Schema creation + `user_version` migrations for the orchestration DB.
//! Pre-v9 SQL is a byte-copy of the deleted TS twin's template literals
//! (indentation and trailing whitespace included) so the `sqlite_master.sql`
//! text of an in-the-field database still matches; v9 and later are authored
//! here, because Rust is now the sole owner of this schema.

use orca_store::{Database, StoreError};
use rusqlite::OptionalExtension;

// Why: v1 → v2 added 'heartbeat' to messages.type CHECK + last_heartbeat_at;
// v2 → v3 added messages.delivered_at; v3 → v4 tasks.created_by_terminal_handle;
// v4 → v5 tasks.task_title/display_name; v5 → v6 pane-identity columns
// (dispatch_contexts.assignee_pane_key, messages.sender_pane_key) so
// worker_done ownership survives a terminal handle remint; v6 → v7
// messages.recipient_pane_key so delivery follows the pane when the addressed
// handle goes stale (#9163 delivery-follows-identity); v7 → v8
// decision_gates.origin_message_id so resolving a gate can reply to the ask that
// opened it, instead of unblocking the task while the worker hangs to timeout;
// v8 → v9 durable run ownership + gate policy + the waiting_gate dispatch state
// (see the ladder step, which also carries the downgrade fence); v9 → v10
// dispatch capability tokens (capability_hash + identity binding on
// dispatch_contexts, plus the contract_version legacy/current marker) so a
// worker must present the minted `dcap_` secret, not just know a dispatch id;
// v10 → v11 the durable mutation-receipt idempotency ledger (mutation_receipts)
// so a retried mutating RPC applies once and replays its recorded result.
pub(crate) const SCHEMA_VERSION: i64 = 11;

/// Full-schema creation. Pre-v9 text is the db.ts `createTables` byte-copy; the
/// v9 columns are appended at the END of each table body so a migrated DB (where
/// `ALTER TABLE ADD COLUMN` can only append) has the same column ORDER as a fresh one.
///
/// No CHECK on `phase` / `gate_resolution_policy`: v9 exists partly because
/// `dispatch_contexts.status` carried one and SQLite cannot widen it in place.
/// Both value sets are still open (design §13 Q2), so constraining them here
/// would buy a table rebuild later; the services validate before writing.
/// Indexes over v9-added columns are NOT here — a legacy DB reaches
/// `create_tables` before the ladder adds those columns (see
/// `create_v9_indexes_and_fence_if_possible`).
const CREATE_TABLES_SQL: &str = r#"
      CREATE TABLE IF NOT EXISTS messages (
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
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
      CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

      CREATE TABLE IF NOT EXISTS tasks (
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
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE IF NOT EXISTS dispatch_contexts (
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
        completed_at        TEXT,
        gate_resolution_policy TEXT NOT NULL DEFAULT 'human-only',
        gate_category_allowlist TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id              TEXT PRIMARY KEY,
        run_id          TEXT,
        actor           TEXT NOT NULL,
        action          TEXT NOT NULL,
        target_pane_key TEXT,
        target_handle   TEXT,
        evidence_ref    TEXT,
        detail          TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(run_id);

      CREATE TRIGGER IF NOT EXISTS trg_audit_events_append_only
        BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only');
      END;

      CREATE TABLE IF NOT EXISTS rotation_sagas (
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
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_rotation_target_route
        ON rotation_sagas(target_route_key) WHERE reservation_released_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rotation_target_store
        ON rotation_sagas(target_store_key) WHERE reservation_released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_rotation_provider
        ON rotation_sagas(provider, reservation_released_at);

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

/// v8 → v9 dispatch_contexts rebuild — the `messages` precedent above, applied to
/// the status CHECK that must learn `waiting_gate` (§6.2). Every v8 column is
/// copied by name, `run_id` arrives with the new body, and the two indexes
/// DROP TABLE removed are recreated. The rebuilt column order matches the fresh
/// schema, which also converges the v1-migrated order (assignee_pane_key had
/// landed at the end there via ALTER).
const DISPATCH_WAITING_GATE_REBUILD_SQL: &str = r#"
            CREATE TABLE dispatch_contexts_new (
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
            );
            INSERT INTO dispatch_contexts_new (
              id, task_id, assignee_handle, assignee_pane_key, status,
              failure_count, last_failure, dispatched_at, completed_at,
              created_at, last_heartbeat_at
            )
            SELECT
              id, task_id, assignee_handle, assignee_pane_key, status,
              failure_count, last_failure, dispatched_at, completed_at,
              created_at, last_heartbeat_at
            FROM dispatch_contexts;
            DROP TABLE dispatch_contexts;
            ALTER TABLE dispatch_contexts_new RENAME TO dispatch_contexts;

            CREATE INDEX idx_dispatch_task ON dispatch_contexts(task_id);
            CREATE INDEX idx_dispatch_status ON dispatch_contexts(status);
          "#;

/// Indexes + the downgrade fence over columns the v9 ladder adds. Split out of
/// `CREATE_TABLES_SQL` because a legacy DB runs `create_tables` first, when
/// `run_id` does not exist yet and these statements would fail; the ladder calls
/// this again once the columns are there. DROP TABLE in the rebuild above takes
/// the trigger with it, which is the other reason it is created here (after).
const V9_INDEX_AND_FENCE_SQL: &str = r#"
      CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
      CREATE INDEX IF NOT EXISTS idx_gates_run ON decision_gates(run_id);

      CREATE TRIGGER IF NOT EXISTS trg_dispatch_waiting_gate_fence
        BEFORE INSERT ON dispatch_contexts
        WHEN EXISTS (
          SELECT 1 FROM dispatch_contexts d
          WHERE d.status = 'waiting_gate'
            AND (d.assignee_handle = NEW.assignee_handle
              OR d.assignee_pane_key = NEW.assignee_pane_key)
        )
      BEGIN
        SELECT RAISE(ABORT, 'assignee is parked in waiting_gate: refusing a second dispatch (schema v9)');
      END;
    "#;

/// §6.2's "one active gate per task", as the SQLite idiom: a partial unique
/// index. Non-unique `idx_gates_task` stays for the task-scoped lookups.
const ONE_PENDING_GATE_INDEX_SQL: &str =
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_gates_one_pending_per_task ON decision_gates(task_id) WHERE status = 'pending'";

/// Columns v9 adds by `ALTER TABLE`, applied in this order. All nullable except
/// the three that are invariant operands: a CAS `version` may not be null
/// (legacy rows backfill to 0), and the per-run gate policy + its category
/// allowlist must read fail-closed rather than force every consumer to decide
/// what a null policy means. `dispatch_contexts.run_id` is absent on purpose —
/// it arrives with the table rebuild.
const V9_ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("tasks", "run_id", "run_id TEXT"),
    ("decision_gates", "run_id", "run_id TEXT"),
    ("decision_gates", "category", "category TEXT"),
    ("decision_gates", "default_option", "default_option TEXT"),
    ("decision_gates", "manager_deadline_at", "manager_deadline_at TEXT"),
    ("decision_gates", "hard_deadline_at", "hard_deadline_at TEXT"),
    ("decision_gates", "policy_snapshot", "policy_snapshot TEXT"),
    ("decision_gates", "resolved_by", "resolved_by TEXT"),
    ("decision_gates", "resolution_reason", "resolution_reason TEXT"),
    ("decision_gates", "version", "version INTEGER NOT NULL DEFAULT 0"),
    (
        "coordinator_runs",
        "gate_resolution_policy",
        "gate_resolution_policy TEXT NOT NULL DEFAULT 'human-only'",
    ),
    (
        "coordinator_runs",
        "gate_category_allowlist",
        "gate_category_allowlist TEXT NOT NULL DEFAULT '[]'",
    ),
];

/// Columns v10 adds to `dispatch_contexts` by `ALTER TABLE`, in the fresh-DDL
/// append order so a migrated DB has the same column ORDER as a fresh one.
/// `contract_version` is NOT NULL with the CURRENT default for the ALTER's
/// benefit; the ladder step then backfills pre-existing rows to LEGACY (they
/// predate capability minting, and 1-vs-0 is how consumers tell them apart).
const V10_ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    (
        "dispatch_contexts",
        "contract_version",
        "contract_version INTEGER NOT NULL DEFAULT 1",
    ),
    ("dispatch_contexts", "launch_token_hash", "launch_token_hash TEXT"),
    ("dispatch_contexts", "capability_hash", "capability_hash TEXT"),
    ("dispatch_contexts", "process_incarnation", "process_incarnation TEXT"),
    ("dispatch_contexts", "capability_revoked_at", "capability_revoked_at TEXT"),
];

/// v10 → v11: the durable mutation-receipt ledger. A whole new table, so the
/// rung is a plain `CREATE TABLE IF NOT EXISTS` — no ALTER/backfill dance — and
/// `IF NOT EXISTS` keeps it safe alongside the same DDL in `CREATE_TABLES_SQL`
/// (a fresh DB already has the table before the ladder runs).
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

// Why: written with \n escapes (not a raw string) because the statement has no
// terminating `;`, so SQLite stores the trailing "\n    " into sqlite_master.sql
// — literal trailing whitespace in source would be fragile.
const UNDELIVERED_INBOX_INDEX_SQL: &str =
    "\n      CREATE INDEX IF NOT EXISTS idx_messages_undelivered_inbox\n        ON messages(to_handle, read, delivered_at, sequence)\n    ";

/// Idempotent full-schema creation, then the two column-gated index sets.
pub(crate) fn create_tables(db: &Database) -> Result<(), StoreError> {
    db.exec(CREATE_TABLES_SQL)?;
    create_undelivered_inbox_index_if_possible(db)?;
    create_v9_indexes_and_fence_if_possible(db)
}

/// TS `migrate`: incremental `user_version` ladder inside one transaction.
/// `user_version` is bumped only on success; a current-or-future version
/// (>= SCHEMA_VERSION) returns immediately and is left untouched (mirrors TS).
pub(crate) fn migrate(db: &Database) -> Result<(), StoreError> {
    let current = db.pragma_i64("user_version")?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }
    db.exec("BEGIN")?;
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

fn apply_version_ladder(db: &Database, current: i64) -> Result<(), StoreError> {
    // v1 → v2: add last_heartbeat_at; rebuild messages to widen the type CHECK
    // (SQLite cannot ALTER a CHECK constraint). The rebuild also carries the
    // v3 delivered_at column so v1 DBs need only one table rewrite.
    if current < 2 {
        if !has_column(db, "dispatch_contexts", "last_heartbeat_at")? {
            db.exec("ALTER TABLE dispatch_contexts ADD COLUMN last_heartbeat_at TEXT")?;
        }
        if !messages_type_check_allows_heartbeat(db)? {
            db.exec(MESSAGES_HEARTBEAT_REBUILD_SQL)?;
        }
    }
    // v2 → v3: DBs that reached v2 via the rebuild above already have the
    // column; this covers DBs that were at v2 before v3 shipped.
    if current < 3 {
        if !has_column(db, "messages", "delivered_at")? {
            db.exec("ALTER TABLE messages ADD COLUMN delivered_at TEXT")?;
        }
    }
    if current < 4 {
        if !has_column(db, "tasks", "created_by_terminal_handle")? {
            db.exec("ALTER TABLE tasks ADD COLUMN created_by_terminal_handle TEXT")?;
        }
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
    // v6 → v7: recipient pane identity so delivery can follow a reminted handle.
    if current < 7 {
        if !has_column(db, "messages", "recipient_pane_key")? {
            db.exec("ALTER TABLE messages ADD COLUMN recipient_pane_key TEXT")?;
        }
    }
    // v7 → v8: decision_gates.origin_message_id couples a gate back to the ask
    // message that opened it, so resolving the gate can answer the blocked worker.
    //
    // Downgrade/upgrade safety: the column is nullable and every read is defensive.
    // A gate created by a pre-v8 build reads back `null` and the resolve path simply
    // skips the thread reply — exactly today's behavior — instead of failing. An
    // older binary opening a v8 DB selects by explicit column list and never sees it.
    if current < 8 {
        if !has_column(db, "decision_gates", "origin_message_id")? {
            db.exec("ALTER TABLE decision_gates ADD COLUMN origin_message_id TEXT")?;
        }
    }
    // v8 → v9: durable run ownership (`run_id` on tasks/dispatches/gates), the
    // gate policy + CAS columns, the per-run gateResolutionPolicy, one pending
    // gate per task, the audit ledger and rotation sagas, and the `waiting_gate`
    // dispatch state — which needs a table rebuild, not an ALTER, because SQLite
    // cannot widen the status CHECK in place.
    //
    // NOT DOWNGRADE-SAFE, and this is the fence. `migrate` deliberately accepts a
    // future-version DB (the `current >= SCHEMA_VERSION` early return above), so a
    // v8 binary opens a v9 file happily — and every active-dispatch predicate it
    // has knows only 'pending'/'dispatched', so it reads a pane parked in
    // `waiting_gate` as free and hands it a second task. `trg_dispatch_waiting_gate_fence`
    // makes SQLite itself abort that INSERT, so an old binary fails loudly instead
    // of double-dispatching. Reverting a v9 file to v8 is still unsupported; the
    // fence only removes the silence.
    if current < 9 {
        if !dispatch_status_check_allows_waiting_gate(db)? {
            db.exec(DISPATCH_WAITING_GATE_REBUILD_SQL)?;
        }
        for (table, column, declaration) in V9_ADDED_COLUMNS {
            if !has_column(db, table, column)? {
                db.exec(&format!("ALTER TABLE {table} ADD COLUMN {declaration}"))?;
            }
        }
    }
    // v9 → v10: dispatch capability columns — a pure-ALTER step (no CHECK
    // changes). The backfill runs AFTER the ALTERs, inside the same
    // transaction: SQLite stamps existing rows with the ALTER default
    // (CURRENT), but a pre-migration row was never minted a capability, so it
    // must read as LEGACY — `capability_hash IS NULL` selects exactly the rows
    // that predate this step (a fresh DB has no rows; a migrated one has no
    // hashes yet).
    if current < 10 {
        for (table, column, declaration) in V10_ADDED_COLUMNS {
            if !has_column(db, table, column)? {
                db.exec(&format!("ALTER TABLE {table} ADD COLUMN {declaration}"))?;
            }
        }
        db.connection().execute(
            "UPDATE dispatch_contexts SET contract_version = ?1 WHERE capability_hash IS NULL",
            rusqlite::params![crate::orchestration::LEGACY_CONTRACT_VERSION],
        )?;
    }
    // v10 → v11: fresh table, no backfill. `CREATE TABLE IF NOT EXISTS` is safe
    // against the twin DDL a fresh DB already ran in `create_tables`.
    if current < 11 {
        db.exec(MUTATION_RECEIPTS_SQL)?;
    }
    create_undelivered_inbox_index_if_possible(db)?;
    create_v9_indexes_and_fence_if_possible(db)?;
    db.exec(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
}

fn create_undelivered_inbox_index_if_possible(db: &Database) -> Result<(), StoreError> {
    if !has_column(db, "messages", "delivered_at")? {
        return Ok(());
    }
    db.exec(UNDELIVERED_INBOX_INDEX_SQL)
}

/// Whether `dispatch_contexts.status` already accepts 'waiting_gate'. Read from
/// `sqlite_master` rather than attempted-and-rolled-back INSERT: the ladder runs
/// inside the migration transaction, where a CHECK failure would poison it.
fn dispatch_status_check_allows_waiting_gate(db: &Database) -> Result<bool, StoreError> {
    let conn = db.connection();
    let mut stmt =
        conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_contexts'")?;
    let sql: Option<String> = stmt.query_row([], |row| row.get(0)).optional()?;
    // A missing table means `create_tables` will build the current shape, so there is
    // nothing to rebuild.
    Ok(sql.is_none_or(|sql| sql.contains("waiting_gate")))
}

/// v9's indexes and downgrade fence, skipped while the columns they name are absent.
/// A legacy DB reaches `create_tables` before the ladder has added `run_id`, and the
/// ladder calls this again once it has.
///
/// The one-pending-gate index is applied separately and its failure is swallowed: a
/// field database that already holds two pending gates for one task cannot build the
/// unique index, and refusing to open would strand a user's whole orchestration DB over
/// an invariant that only constrains new writes. The gate service enforces it either way;
/// this index is defence in depth, not the mechanism.
fn create_v9_indexes_and_fence_if_possible(db: &Database) -> Result<(), StoreError> {
    if !has_column(db, "tasks", "run_id")? || !has_column(db, "decision_gates", "run_id")? {
        return Ok(());
    }
    db.exec(V9_INDEX_AND_FENCE_SQL)?;
    let _ = db.exec(ONE_PENDING_GATE_INDEX_SQL);
    Ok(())
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

// Why: sqlite_master keeps the original CREATE TABLE text including the CHECK
// clause; inspecting it is the cheapest reliable pre-rebuild probe (same as TS).
fn messages_type_check_allows_heartbeat(db: &Database) -> Result<bool, StoreError> {
    let sql: Option<Option<String>> = db
        .connection()
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(sql.flatten().is_some_and(|s| s.contains("'heartbeat'")))
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
        assert!(!messages_type_check_allows_heartbeat(&db).unwrap());
        db.exec("CREATE TABLE messages (type TEXT CHECK(type IN ('status')))").unwrap();
        assert!(!messages_type_check_allows_heartbeat(&db).unwrap());
        db.exec("DROP TABLE messages").unwrap();
        db.exec("CREATE TABLE messages (type TEXT CHECK(type IN ('status', 'heartbeat')))")
            .unwrap();
        assert!(messages_type_check_allows_heartbeat(&db).unwrap());
    }

    #[test]
    fn fresh_database_lands_on_current_schema_version() {
        let db = Database::open_in_memory().unwrap();
        create_tables(&db).unwrap();
        migrate(&db).unwrap();
        assert_eq!(db.pragma_i64("user_version").unwrap(), SCHEMA_VERSION);
        // Idempotent: a second migrate is a no-op.
        migrate(&db).unwrap();
        assert_eq!(db.pragma_i64("user_version").unwrap(), SCHEMA_VERSION);
    }

    fn column_names(db: &Database, table: &str) -> Vec<String> {
        let conn = db.connection();
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut names = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            names.push(row.get::<_, String>("name").unwrap());
        }
        names
    }

    // The exact dispatch_contexts shape a v9 install wrote (post-rebuild), so
    // v10 is proved against migrated rows, not fresh rows that omit the values.
    #[test]
    fn v9_database_migrates_to_v10_losslessly() {
        let db = Database::open_in_memory().unwrap();
        db.exec(
            "CREATE TABLE dispatch_contexts (
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
             );
             INSERT INTO dispatch_contexts (id, task_id, assignee_handle, status, failure_count)
               VALUES ('ctx_v9', 'task_v9', 'term_worker', 'dispatched', 2);",
        )
        .unwrap();
        db.exec("PRAGMA user_version = 9").unwrap();

        create_tables(&db).unwrap();
        migrate(&db).unwrap();
        assert_eq!(db.pragma_i64("user_version").unwrap(), SCHEMA_VERSION);

        // Lossless: the v9 row survives; the new columns read as never-minted
        // LEGACY (contract_version backfilled to 0, everything else NULL).
        let row = db
            .connection()
            .query_row(
                "SELECT assignee_handle, failure_count, contract_version, launch_token_hash,
                        capability_hash, process_incarnation, capability_revoked_at
                 FROM dispatch_contexts WHERE id = 'ctx_v9'",
                [],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, ("term_worker".to_string(), 2, 0, None, None, None, None));

        // A row inserted AFTER migration reads the CURRENT contract default.
        db.exec("INSERT INTO dispatch_contexts (id, task_id, status) VALUES ('ctx_new', 't2', 'pending')")
            .unwrap();
        let contract: i64 = db
            .connection()
            .query_row(
                "SELECT contract_version FROM dispatch_contexts WHERE id = 'ctx_new'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(contract, crate::orchestration::CURRENT_CONTRACT_VERSION);

        // The append convention held: migrated column order == fresh column order.
        let fresh = Database::open_in_memory().unwrap();
        create_tables(&fresh).unwrap();
        migrate(&fresh).unwrap();
        assert_eq!(column_names(&db, "dispatch_contexts"), column_names(&fresh, "dispatch_contexts"));
    }

    fn table_exists(db: &Database, name: &str) -> bool {
        db.connection()
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [name],
                |_| Ok(()),
            )
            .optional()
            .unwrap()
            .is_some()
    }

    // Proves the `if current < 11` rung ALONE (no create_tables) adds the table,
    // so a real v10 file on the field gains mutation_receipts on upgrade.
    #[test]
    fn v10_database_migrates_to_v11_adding_mutation_receipts() {
        let db = Database::open_in_memory().unwrap();
        db.exec(
            "CREATE TABLE dispatch_contexts (
               id                TEXT PRIMARY KEY,
               task_id           TEXT NOT NULL,
               assignee_handle   TEXT,
               status            TEXT NOT NULL DEFAULT 'pending',
               contract_version  INTEGER NOT NULL DEFAULT 1,
               capability_hash   TEXT
             );
             INSERT INTO dispatch_contexts (id, task_id, assignee_handle, status)
               VALUES ('ctx_v10', 'task_v10', 'term_worker', 'dispatched');",
        )
        .unwrap();
        db.exec("PRAGMA user_version = 10").unwrap();
        assert!(!table_exists(&db, "mutation_receipts"));

        migrate(&db).unwrap();
        assert_eq!(db.pragma_i64("user_version").unwrap(), SCHEMA_VERSION);
        assert!(table_exists(&db, "mutation_receipts"));

        // Lossless: the pre-existing dispatch row is untouched.
        let handle: String = db
            .connection()
            .query_row(
                "SELECT assignee_handle FROM dispatch_contexts WHERE id = 'ctx_v10'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(handle, "term_worker");

        // The new table takes rows and applies its column defaults.
        db.connection()
            .execute(
                "INSERT INTO mutation_receipts (caller_fingerprint, request_id, method, payload_hash)
                 VALUES ('peer-a', 'req-1', 'startWorker', 'hash-1')",
                [],
            )
            .unwrap();
        let (state, receipt, created): (String, Option<String>, String) = db
            .connection()
            .query_row(
                "SELECT state, receipt, created_at FROM mutation_receipts WHERE request_id = 'req-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, "pending");
        assert_eq!(receipt, None);
        assert!(!created.is_empty());

        // A fresh v11 DB creates an identically shaped table.
        let fresh = Database::open_in_memory().unwrap();
        create_tables(&fresh).unwrap();
        migrate(&fresh).unwrap();
        assert!(table_exists(&fresh, "mutation_receipts"));
        assert_eq!(
            column_names(&db, "mutation_receipts"),
            column_names(&fresh, "mutation_receipts")
        );

        // The CHECK constraint holds: an unknown state is rejected.
        assert!(db
            .connection()
            .execute(
                "INSERT INTO mutation_receipts (caller_fingerprint, request_id, method, payload_hash, state)
                 VALUES ('peer-a', 'req-2', 'm', 'h', 'bogus')",
                [],
            )
            .is_err());
    }
}
