import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('audit ledger (schema v9)', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    // Why: Windows keeps the SQLite file locked until the handle closes, so the
    // DB must close before recursive cleanup.
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('appends a full row and mints its own id', () => {
    const d = createDb()
    const run = d.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord' })

    const event = d.audit.append({
      runId: run.id,
      actor: 'manager:orchestrator',
      action: 'submit-agent-prompt',
      targetPaneKey: 'tab_1:5f8d2b1a-0000-4000-8000-000000000001',
      targetHandle: 'term_worker',
      evidenceRef: 'op_1234',
      detail: '{"promptLength":412,"promptSha256":"ab12"}'
    })

    expect(event.id).toMatch(/^audit_/)
    expect(event.run_id).toBe(run.id)
    expect(event.actor).toBe('manager:orchestrator')
    expect(event.action).toBe('submit-agent-prompt')
    expect(event.target_pane_key).toBe('tab_1:5f8d2b1a-0000-4000-8000-000000000001')
    expect(event.target_handle).toBe('term_worker')
    expect(event.evidence_ref).toBe('op_1234')
    expect(event.detail).toBe('{"promptLength":412,"promptSha256":"ab12"}')
    expect(event.created_at).toBeTruthy()
  })

  it('reads back every optional column as null when only the required pair is given', () => {
    const d = createDb()
    const event = d.audit.append({ actor: 'human', action: 'takeover' })

    expect(event.run_id).toBeNull()
    expect(event.target_pane_key).toBeNull()
    expect(event.target_handle).toBeNull()
    expect(event.evidence_ref).toBeNull()
    expect(event.detail).toBeNull()
    // An event outside any run still lists — a null run filter is "no filter".
    expect(d.audit.list().map((e) => e.id)).toEqual([event.id])
  })

  it('lists newest first, filters by run, and pages', () => {
    const d = createDb()
    const run = d.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord' })
    const first = d.audit.append({ runId: run.id, actor: 'service:gate', action: 'gate-opened' })
    const second = d.audit.append({ runId: run.id, actor: 'human', action: 'gate-resolved' })
    const unscoped = d.audit.append({ actor: 'human', action: 'grant-revoked' })

    expect(d.audit.list({ runId: run.id }).map((e) => e.id)).toEqual([second.id, first.id])
    expect(d.audit.list({ runId: run.id, limit: 1 }).map((e) => e.id)).toEqual([second.id])
    expect(d.audit.list({ runId: run.id, limit: 1, offset: 1 }).map((e) => e.id)).toEqual([
      first.id
    ])
    expect(d.audit.list().map((e) => e.id)).toContain(unscoped.id)
  })

  it('is append-only — the schema aborts an UPDATE, so a record cannot be edited later', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-audit-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const d = new OrchestrationDb(dbPath)
    db = d
    const event = d.audit.append({ actor: 'manager:m', action: 'rotation-performed' })
    d.close()
    db = undefined

    const raw = new Database(dbPath)
    try {
      expect(() =>
        raw.prepare('UPDATE audit_events SET action = ? WHERE id = ?').run('rewritten', event.id)
      ).toThrow(/append-only/)
      expect(raw.prepare('SELECT action FROM audit_events WHERE id = ?').get(event.id)).toEqual({
        action: 'rotation-performed'
      })
    } finally {
      raw.close()
    }
  })
})
