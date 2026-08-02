import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

// A real v8 database — the shape an installed build wrote before schema v9 —
// so "reads defensively" is proved against migrated rows rather than against
// fresh rows that merely happen to omit the new values.
const V8_SCHEMA = `
  CREATE TABLE messages (
    id TEXT NOT NULL, from_handle TEXT NOT NULL, to_handle TEXT NOT NULL,
    subject TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'status'
      CHECK(type IN ('status','dispatch','worker_done','merge_ready','escalation','handoff','decision_gate','heartbeat')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high','urgent')),
    thread_id TEXT, payload TEXT, read INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT, sender_pane_key TEXT, recipient_pane_key TEXT
  );
  CREATE UNIQUE INDEX idx_messages_id ON messages(id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, parent_id TEXT, created_by_terminal_handle TEXT,
    task_title TEXT, display_name TEXT, spec TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','ready','dispatched','completed','failed','blocked')),
    deps TEXT NOT NULL DEFAULT '[]', result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
  );

  CREATE TABLE dispatch_contexts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, assignee_handle TEXT,
    assignee_pane_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','dispatched','completed','failed','circuit_broken')),
    failure_count INTEGER NOT NULL DEFAULT 0, last_failure TEXT,
    dispatched_at TEXT, completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), last_heartbeat_at TEXT
  );

  CREATE TABLE decision_gates (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','timeout')),
    resolution TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT, origin_message_id TEXT
  );

  CREATE TABLE coordinator_runs (
    id TEXT PRIMARY KEY, spec TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','completed','failed')),
    coordinator_handle TEXT NOT NULL, poll_interval_ms INTEGER NOT NULL DEFAULT 2000,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
  );

  INSERT INTO tasks (id, spec, status, deps) VALUES ('task_legacy', 'work from before v9', 'ready', '[]');
  INSERT INTO tasks (id, spec, status, deps) VALUES ('task_done', 'finished before v9', 'completed', '[]');
  INSERT INTO dispatch_contexts (id, task_id, assignee_handle, status)
    VALUES ('ctx_legacy', 'task_legacy', 'term_worker', 'completed');
  INSERT INTO decision_gates (id, task_id, question, status)
    VALUES ('gate_legacy', 'task_done', 'Shipped?', 'resolved');
  INSERT INTO coordinator_runs (id, spec, status, coordinator_handle)
    VALUES ('run_legacy', 'old mission', 'completed', 'term_coord');
`

describe('pre-v9 rows after migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    // Why: Windows keeps the SQLite file locked until the handle closes.
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function openMigratedV8Database(): OrchestrationDb {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-v8-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const raw = new Database(dbPath)
    raw.exec(V8_SCHEMA)
    raw.pragma('user_version = 8')
    raw.close()
    db = new OrchestrationDb(dbPath)
    return db
  }

  it('reads every new nullable column as null, and the CAS operand as 0', () => {
    const d = openMigratedV8Database()

    expect(d.getTask('task_legacy')?.run_id).toBeNull()
    expect(d.getDispatchContextById('ctx_legacy')?.run_id).toBeNull()

    const gate = d.getGate('gate_legacy')
    expect(gate?.run_id).toBeNull()
    expect(gate?.category).toBeNull()
    expect(gate?.default_option).toBeNull()
    expect(gate?.manager_deadline_at).toBeNull()
    expect(gate?.hard_deadline_at).toBeNull()
    expect(gate?.policy_snapshot).toBeNull()
    expect(gate?.resolved_by).toBeNull()
    expect(gate?.resolution_reason).toBeNull()
    // NOT NULL DEFAULT 0: a CAS operand may not be null, so the backfill is a
    // usable version rather than something every caller must null-check.
    expect(gate?.version).toBe(0)
  })

  it('backfills a legacy run to the fail-closed gate policy', () => {
    const d = openMigratedV8Database()
    const run = d.getCoordinatorRun('run_legacy')

    expect(run?.gate_resolution_policy).toBe('human-only')
    expect(run?.gate_category_allowlist).toBe('[]')
    expect(d.runs.list().map((r) => r.id)).toEqual(['run_legacy'])
  })

  it('still lists un-owned rows, because a null run filter is not a filter', () => {
    const d = openMigratedV8Database()

    expect(
      d
        .listTasks()
        .map((t) => t.id)
        .sort()
    ).toEqual(['task_done', 'task_legacy'])
    expect(d.listTasks({ status: 'completed' }).map((t) => t.id)).toEqual(['task_done'])
    expect(d.listGates().map((g) => g.id)).toEqual(['gate_legacy'])
    // The legacy dispatch survived the waiting_gate table rebuild intact.
    expect(d.getDispatchContextById('ctx_legacy')?.assignee_handle).toBe('term_worker')
  })

  it('fences a pre-v9 binary out of double-dispatching a parked pane', () => {
    const d = openMigratedV8Database()
    const task = d.createTask({ spec: 'work' })
    d.createDispatchContext(task.id, 'term_worker_2')
    d.gatePolicy.parkDispatch(task.id)
    const dbPath = join(tempDir as string, 'orchestration.db')
    d.close()
    db = undefined

    // A v8 binary knows only pending/dispatched, so it reads a parked pane as
    // free and inserts a second dispatch. SQLite itself has to refuse — that is
    // what makes the not-downgrade-safe part loud instead of silent.
    const raw = new Database(dbPath)
    try {
      expect(() =>
        raw
          .prepare(
            `INSERT INTO dispatch_contexts (id, task_id, assignee_handle, status)
             VALUES ('ctx_from_v8', 'task_legacy', 'term_worker_2', 'dispatched')`
          )
          .run()
      ).toThrow(/waiting_gate/)
    } finally {
      raw.close()
    }
  })

  it('adopts the legacy live task into the first run started after the upgrade', () => {
    const d = openMigratedV8Database()
    const run = d.createCoordinatorRun({ spec: 'first run after upgrade', coordinatorHandle: 'c' })

    // The point of adoption: an existing install's un-owned work keeps running.
    expect(d.getTask('task_legacy')?.run_id).toBe(run.id)
    expect(d.listTasks({ runId: run.id }).map((t) => t.id)).toEqual(['task_legacy'])
    // Its finished history stays unattributed rather than being claimed.
    expect(d.getTask('task_done')?.run_id).toBeNull()
    expect(d.getGate('gate_legacy')?.run_id).toBeNull()
  })
})
