import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createMockRuntime, insertWorkerDone } from './coordinator-test-fixtures'
import { Coordinator } from './coordinator'

// Which panes the automatic dispatch loop is allowed to drive, and how it reconciles
// dispatches whose worker pane did not survive a restart.
describe('Coordinator worker targeting', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('refuses to dispatch into a pane it did not create and cannot confirm is an agent', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [
      { handle: 'term_human', worktreeId: 'wt1', connected: true, writable: true }
    ]
    // A bare shell: the runtime knows the pty but reports no agent on it. Pasting a
    // preamble here would execute the text as shell commands.
    runtime.launchProfiles.term_human = { agent: null, agentArgs: null, agentEnv: null }

    const task = db.createTask({ spec: 'work' })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20
    })

    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    coordinator.stop()
    await runPromise

    expect(runtime.sentMessages.filter((m) => m.handle === 'term_human')).toHaveLength(0)
    // It creates its own worker instead of borrowing the human's shell.
    expect(runtime.createdTerminals.length).toBe(1)
    expect(db.getDispatchContext(task.id)?.assignee_handle).toBe(runtime.createdTerminals[0])
  })

  it('waits for a freshly created worker to settle before dispatching into it', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const waited: { handle: string; condition?: string }[] = []
    const order: string[] = []
    runtime.waitForTerminal = async (handle: string, options?: { condition?: string }) => {
      waited.push({ handle, condition: options?.condition })
      order.push(`wait:${handle}`)
      return { handle, condition: options?.condition ?? 'tui-idle' }
    }
    const send = runtime.sendTerminalAgentPrompt.bind(runtime)
    runtime.sendTerminalAgentPrompt = async (handle: string, prompt: string) => {
      order.push(`send:${handle}`)
      return send(handle, prompt)
    }

    const task = db.createTask({ spec: 'work' })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20
    })
    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })

    const created = runtime.createdTerminals[0]
    expect(waited).toEqual([{ handle: created, condition: 'tui-idle' }])
    expect(order).toEqual([`wait:${created}`, `send:${created}`])

    insertWorkerDone(db, { taskId: task.id, from: created })
    await runPromise
  })

  it('dispatches anyway when the settle wait fails, and says so', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.waitForTerminal = async () => {
      throw new Error('timeout')
    }
    const logs: string[] = []

    const task = db.createTask({ spec: 'work' })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      onLog: (m) => logs.push(m)
    })
    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })

    expect(runtime.sentMessages.length).toBeGreaterThan(0)
    expect(logs.some((l) => l.includes('dispatching anyway'))).toBe(true)

    insertWorkerDone(db, { taskId: task.id, from: runtime.createdTerminals[0] })
    await runPromise
  })

  describe('orphaned dispatch reconciliation', () => {
    const leafId = '22222222-2222-4222-8222-222222222222'

    it('returns a task to ready when its worker pane is gone', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      const withPaneLookup = Object.assign(runtime, {
        // No live pane carries the dispatch's leaf id.
        getTerminalPaneKey: (handle: string) => `tab_live:${handle}`
      })
      const logs: string[] = []

      const task = db.createTask({ spec: 'interrupted work' })
      const ctx = db.createDispatchContext(task.id, 'term_dead', `tab_old:${leafId}`)
      expect(db.getTask(task.id)?.status).toBe('dispatched')

      const coordinator = new Coordinator(db, withPaneLookup, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 20,
        onLog: (m) => logs.push(m)
      })
      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 60)
      })
      coordinator.stop()
      await runPromise

      expect(db.getDispatchContextById(ctx.id)?.status).toBe('failed')
      expect(logs.some((l) => l.includes('no longer exists') && l.includes(task.id))).toBe(true)
      // The task became dispatchable again rather than holding a slot forever.
      expect(['ready', 'dispatched']).toContain(db.getTask(task.id)?.status)
    })

    it('leaves a dispatch alone when its pane survived under a reminted handle', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      runtime.terminals = [
        { handle: 'term_reminted', worktreeId: 'wt1', connected: true, writable: true }
      ]
      const withPaneLookup = Object.assign(runtime, {
        getTerminalPaneKey: (handle: string) =>
          handle === 'term_reminted' ? `tab_after:${leafId}` : null
      })

      const task = db.createTask({ spec: 'survived work' })
      const ctx = db.createDispatchContext(task.id, 'term_before', `tab_before:${leafId}`)

      const coordinator = new Coordinator(db, withPaneLookup, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 20
      })
      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 60)
      })
      coordinator.stop()
      await runPromise

      expect(db.getDispatchContextById(ctx.id)?.status).toBe('dispatched')
      expect(db.getTask(task.id)?.status).toBe('dispatched')
    })

    it('never reaps on ambiguous evidence (no recorded pane key)', async () => {
      db = new OrchestrationDb(':memory:')
      const runtime = createMockRuntime()
      const withPaneLookup = Object.assign(runtime, {
        getTerminalPaneKey: () => null
      })

      const task = db.createTask({ spec: 'legacy row' })
      const ctx = db.createDispatchContext(task.id, 'term_legacy')

      const coordinator = new Coordinator(db, withPaneLookup, {
        spec: 'go',
        coordinatorHandle: 'coord',
        pollIntervalMs: 20
      })
      const runPromise = coordinator.run()
      await new Promise((r) => {
        setTimeout(r, 60)
      })
      coordinator.stop()
      await runPromise

      expect(db.getDispatchContextById(ctx.id)?.status).toBe('dispatched')
    })
  })
})
