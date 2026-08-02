import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('run ownership (schema v9)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('adoption at run start', () => {
    it('adopts the un-owned live tasks that existed before the run, with their gates and dispatches', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'built before any run existed' })
      const ctx = d.createDispatchContext(task.id, 'worker-1')
      const gate = d.createGate({ taskId: task.id, question: 'Proceed?' })

      expect(d.getTask(task.id)?.run_id).toBeNull()

      const run = d.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord' })

      expect(d.getTask(task.id)?.run_id).toBe(run.id)
      expect(d.getGate(gate.id)?.run_id).toBe(run.id)
      expect(d.getDispatchContextById(ctx.id)?.run_id).toBe(run.id)
    })

    it('leaves completed and failed tasks un-owned — they are history, not this run', () => {
      const d = createDb()
      const done = d.createTask({ spec: 'finished last month' })
      d.updateTaskStatus(done.id, 'completed')
      const broke = d.createTask({ spec: 'failed last month' })
      d.updateTaskStatus(broke.id, 'failed')
      const live = d.createTask({ spec: 'still to do' })

      const run = d.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord' })

      expect(d.getTask(done.id)?.run_id).toBeNull()
      expect(d.getTask(broke.id)?.run_id).toBeNull()
      expect(d.getTask(live.id)?.run_id).toBe(run.id)
      // …and the terminal rows are still fully readable, just unattributed.
      expect(d.listTasks({ status: 'completed' }).map((t) => t.id)).toEqual([done.id])
    })

    it('gives two runs racing the same un-owned tasks exactly one winner', () => {
      const d = createDb()
      const first = d.createTask({ spec: 'contested a' })
      const second = d.createTask({ spec: 'contested b' })

      const runA = d.createCoordinatorRun({ spec: 'a', coordinatorHandle: 'coord-a' })
      const runB = d.createCoordinatorRun({ spec: 'b', coordinatorHandle: 'coord-b' })

      // The adoption UPDATE runs inside the run-insert transaction, so the
      // second run finds nothing un-owned left. No task is owned twice, and
      // none is left dangling.
      expect(d.listTasks({ runId: runA.id }).map((t) => t.id)).toEqual([first.id, second.id])
      expect(d.listTasks({ runId: runB.id })).toEqual([])
      expect(d.getTask(first.id)?.run_id).toBe(runA.id)
      expect(d.getTask(second.id)?.run_id).toBe(runA.id)
    })

    it('does not re-adopt a task a previous run already owns', () => {
      const d = createDb()
      const runA = d.createCoordinatorRun({ spec: 'a', coordinatorHandle: 'coord-a' })
      const owned = d.createTask({ spec: 'minted mid-run', runId: runA.id })
      expect(owned.run_id).toBe(runA.id)

      d.createCoordinatorRun({ spec: 'b', coordinatorHandle: 'coord-b' })

      expect(d.getTask(owned.id)?.run_id).toBe(runA.id)
    })
  })

  describe('run filters', () => {
    it('lists un-owned rows when no run is named — a null filter is "no filter"', () => {
      const d = createDb()
      const orphan = d.createTask({ spec: 'never adopted' })
      d.updateTaskStatus(orphan.id, 'completed')
      const run = d.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord' })
      const owned = d.createTask({ spec: 'this run', runId: run.id })

      expect(
        d
          .listTasks()
          .map((t) => t.id)
          .sort()
      ).toEqual([orphan.id, owned.id].sort())
      expect(d.listTasks({ runId: run.id }).map((t) => t.id)).toEqual([owned.id])
    })

    it('narrows gates by run without hiding un-owned ones from the unfiltered read', () => {
      const d = createDb()
      const orphanTask = d.createTask({ spec: 'legacy' })
      // createGate blocks its task, so completing it AFTER is what makes this a
      // gate whose task is terminal — the case adoption must pass over.
      const orphanGate = d.createGate({ taskId: orphanTask.id, question: 'stale?' })
      d.updateTaskStatus(orphanTask.id, 'completed')
      const run = d.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord' })
      const task = d.createTask({ spec: 'live', runId: run.id })
      const gate = d.createGate({ taskId: task.id, question: 'Ship?', runId: run.id })

      expect(d.listGates({ runId: run.id }).map((g) => g.id)).toEqual([gate.id])
      expect(
        d
          .listGates()
          .map((g) => g.id)
          .sort()
      ).toEqual([gate.id, orphanGate.id].sort())
    })
  })

  describe('run listing', () => {
    it('pages newest first through a real limit/offset query', () => {
      const d = createDb()
      const runs = ['a', 'b', 'c', 'd'].map((spec) =>
        d.createCoordinatorRun({ spec, coordinatorHandle: `coord-${spec}` })
      )

      // created_at has second granularity, so rowid breaks the tie newest-first.
      const newestTwo = d.runs.list({ limit: 2 })
      expect(newestTwo.map((r) => r.id)).toEqual([runs[3].id, runs[2].id])
      expect(d.runs.list({ limit: 2, offset: 2 }).map((r) => r.id)).toEqual([
        runs[1].id,
        runs[0].id
      ])
      // The limit is applied in SQL, not by slicing a full read.
      expect(d.runs.list({ limit: 1 })).toHaveLength(1)
      expect(d.runs.list({ limit: 10, offset: 4 })).toEqual([])
    })

    it('defaults the gate policy fail-closed and round-trips an explicit one', () => {
      const d = createDb()
      const fallback = d.createCoordinatorRun({ spec: 'default', coordinatorHandle: 'coord' })
      expect(fallback.gate_resolution_policy).toBe('human-only')
      expect(fallback.gate_category_allowlist).toBe('[]')

      const delegated = d.createCoordinatorRun({
        spec: 'delegated',
        coordinatorHandle: 'coord-2',
        gateResolutionPolicy: 'manager-delegated',
        gateCategoryAllowlist: ['dependency-choice', 'test-scope']
      })
      expect(delegated.gate_resolution_policy).toBe('manager-delegated')
      expect(JSON.parse(delegated.gate_category_allowlist)).toEqual([
        'dependency-choice',
        'test-scope'
      ])
      expect(d.getCoordinatorRun(delegated.id)?.gate_resolution_policy).toBe('manager-delegated')
    })
  })
})
