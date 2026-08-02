import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('gate CAS resolution and waiting_gate parking (schema v9)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('policy columns', () => {
    it('round-trips every v9 gate column and starts version at 0', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const run = d.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord' })
      const gate = d.createGate({
        taskId: task.id,
        question: 'Bump the dependency?',
        options: ['yes', 'no'],
        runId: run.id,
        category: 'dependency-choice',
        defaultOption: 'no',
        managerDeadlineAt: '2026-08-02T12:00:00.000Z',
        hardDeadlineAt: '2026-08-02T18:00:00.000Z',
        policySnapshot: '{"policy":"manager-delegated"}'
      })

      const read = d.getGate(gate.id)
      expect(read?.category).toBe('dependency-choice')
      expect(read?.default_option).toBe('no')
      expect(read?.manager_deadline_at).toBe('2026-08-02T12:00:00.000Z')
      expect(read?.hard_deadline_at).toBe('2026-08-02T18:00:00.000Z')
      expect(read?.policy_snapshot).toBe('{"policy":"manager-delegated"}')
      expect(read?.run_id).toBe(run.id)
      expect(read?.version).toBe(0)
      expect(read?.resolved_by).toBeNull()
      expect(read?.resolution_reason).toBeNull()
    })

    it('leaves every policy column null for a gate opened by the plain ask path', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const gate = d.createGate({ taskId: task.id, question: 'Proceed?' })

      // Null category is uncategorized, which §6.3 makes fail-closed human-only —
      // consumers must be able to read it, not trip over it.
      expect(gate.category).toBeNull()
      expect(gate.default_option).toBeNull()
      expect(gate.manager_deadline_at).toBeNull()
      expect(gate.hard_deadline_at).toBeNull()
      expect(gate.policy_snapshot).toBeNull()
      expect(gate.run_id).toBeNull()
      // …but the CAS operand is NOT nullable, so it is present and usable.
      expect(gate.version).toBe(0)
    })
  })

  describe('resolvePending', () => {
    it('resolves on a matching version and records who and why', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const gate = d.createGate({ taskId: task.id, question: 'Ship?', options: ['yes', 'no'] })

      const outcome = d.gatePolicy.resolvePending(
        gate.id,
        gate.version,
        'yes',
        'manager:orchestrator',
        'inside the delegated category allowlist'
      )

      expect(outcome.outcome).toBe('resolved')
      if (outcome.outcome !== 'resolved') {
        return
      }
      expect(outcome.gate.status).toBe('resolved')
      expect(outcome.gate.resolution).toBe('yes')
      expect(outcome.gate.resolved_by).toBe('manager:orchestrator')
      expect(outcome.gate.resolution_reason).toBe('inside the delegated category allowlist')
      expect(outcome.gate.version).toBe(gate.version + 1)
      expect(outcome.gate.resolved_at).not.toBeNull()
    })

    it('refuses a stale version and hands the loser the committed row', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const gate = d.createGate({ taskId: task.id, question: 'Ship?' })

      const winner = d.gatePolicy.resolvePending(gate.id, gate.version, 'yes', 'human')
      expect(winner.outcome).toBe('resolved')

      // The loser presents the version it read before the race.
      const loser = d.gatePolicy.resolvePending(gate.id, gate.version, 'no', 'manager:m')
      expect(loser.outcome).toBe('version_conflict')
      if (loser.outcome !== 'version_conflict') {
        return
      }
      // It can read what actually happened rather than only "that failed".
      expect(loser.gate.resolution).toBe('yes')
      expect(loser.gate.resolved_by).toBe('human')
    })

    it('reports a missing gate distinctly from a lost race', () => {
      const d = createDb()
      expect(d.gatePolicy.resolvePending('gate_nope', 0, 'yes', 'human').outcome).toBe('not_found')
    })

    it('exposes the pending gate so a caller can read the version to present', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const gate = d.createGate({ taskId: task.id, question: 'Ship?' })

      expect(d.gatePolicy.pendingForTask(task.id)?.id).toBe(gate.id)
      d.gatePolicy.resolvePending(gate.id, gate.version, 'yes', 'human')
      expect(d.gatePolicy.pendingForTask(task.id)).toBeUndefined()
    })
  })

  describe('waiting_gate', () => {
    it('parks the dispatch instead of completing it, then resumes the same worker', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'worker-1')

      const parked = d.gatePolicy.parkDispatch(task.id)
      expect(parked?.id).toBe(ctx.id)
      expect(parked?.status).toBe('waiting_gate')
      expect(d.gatePolicy.listParked().map((p) => p.id)).toEqual([ctx.id])

      const gate = d.createGate({ taskId: task.id, question: 'Ship?' })
      const outcome = d.gatePolicy.resolvePending(gate.id, gate.version, 'yes', 'human')

      expect(outcome.outcome).toBe('resolved')
      if (outcome.outcome !== 'resolved') {
        return
      }
      // The worker keeps its lease: the dispatch resumes and the task stays
      // dispatched, rather than being requeued under a worker still holding it.
      expect(outcome.resumed_dispatch_id).toBe(ctx.id)
      expect(d.getDispatchContextById(ctx.id)?.status).toBe('dispatched')
      expect(d.getTask(task.id)?.status).toBe('dispatched')
      expect(d.gatePolicy.listParked()).toEqual([])
    })

    it('frees the task for redispatch when nothing was parked', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const gate = d.createGate({ taskId: task.id, question: 'Ship?' })

      const outcome = d.gatePolicy.resolvePending(gate.id, gate.version, 'yes', 'human')
      expect(outcome.outcome).toBe('resolved')
      if (outcome.outcome !== 'resolved') {
        return
      }
      expect(outcome.resumed_dispatch_id).toBeNull()
      expect(d.getTask(task.id)?.status).toBe('ready')
    })

    it('returns undefined when the task has no active dispatch to park', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      expect(d.gatePolicy.parkDispatch(task.id)).toBeUndefined()
    })

    it('refuses to hand a parked assignee a second task, and leaves it out of the idle set', () => {
      const d = createDb()
      const first = d.createTask({ spec: 'first' })
      d.insertMessage({ from: 'worker-1', to: 'coord', subject: 'hi' })
      d.createDispatchContext(first.id, 'worker-1')
      d.gatePolicy.parkDispatch(first.id)

      const second = d.createTask({ spec: 'second' })
      // A parked worker still holds its lease, so every "is this assignee free?"
      // predicate has to agree — otherwise resolution hands the pane a second task.
      expect(() => d.createDispatchContext(second.id, 'worker-1')).toThrow(
        /already has an active dispatch/
      )
      expect(d.getIdleTerminals()).not.toContain('worker-1')
      expect(d.getActiveDispatchForTerminal('worker-1')?.status).toBe('waiting_gate')
      expect(d.listTasksWithDispatch().find((t) => t.id === first.id)?.assignee_handle).toBe(
        'worker-1'
      )
    })
  })
})
