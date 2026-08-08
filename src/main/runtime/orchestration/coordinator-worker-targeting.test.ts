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

describe('Coordinator ownership authority (§6.6)', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  async function runBriefly(coordinator: Coordinator): Promise<void> {
    const runPromise = coordinator.run()
    await new Promise((r) => {
      setTimeout(r, 80)
    })
    coordinator.stop()
    await runPromise
  }

  it("will not hijack the human's own agent pane", async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    // The exact shape the old fallback accepted: a pane the fleet never created,
    // running a real agent, in the worktree the human is working in.
    runtime.terminals = [
      { handle: 'term_humans_claude', worktreeId: 'wt1', connected: true, writable: true }
    ]
    runtime.launchProfiles.term_humans_claude = {
      agent: 'claude',
      agentArgs: null,
      agentEnv: null
    }
    // No grant for this run names it, so it is the human's.
    runtime.fleetGrantCoversTargets = false

    db.createTask({ spec: 'work' })
    await runBriefly(
      new Coordinator(db, runtime, { spec: 'go', coordinatorHandle: 'coord', pollIntervalMs: 20 })
    )

    expect(runtime.sentMessages.filter((m) => m.handle === 'term_humans_claude')).toHaveLength(0)
    // It creates its own worker rather than borrowing one it was never given.
    expect(runtime.createdTerminals.length).toBe(1)
  })

  it('adopts an un-owned agent pane once a live grant for the run names it', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [
      { handle: 'term_prepared', worktreeId: 'wt1', connected: true, writable: true }
    ]
    runtime.launchProfiles.term_prepared = { agent: 'claude', agentArgs: null, agentEnv: null }
    // The documented workflow: a human pre-creates a worker and grants it.
    runtime.fleetGrantCoversTargets = true

    db.createTask({ spec: 'work' })
    await runBriefly(
      new Coordinator(db, runtime, { spec: 'go', coordinatorHandle: 'coord', pollIntervalMs: 20 })
    )

    expect(runtime.sentMessages.filter((m) => m.handle === 'term_prepared').length).toBeGreaterThan(
      0
    )
    // No need to spawn its own when a granted pane was available.
    expect(runtime.createdTerminals.length).toBe(0)
  })

  it('a granted pane still must be running an agent — a bare shell is never adopted', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [
      { handle: 'term_shell', worktreeId: 'wt1', connected: true, writable: true }
    ]
    runtime.launchProfiles.term_shell = { agent: null, agentArgs: null, agentEnv: null }
    runtime.fleetGrantCoversTargets = true

    db.createTask({ spec: 'work' })
    await runBriefly(
      new Coordinator(db, runtime, { spec: 'go', coordinatorHandle: 'coord', pollIntervalMs: 20 })
    )

    expect(runtime.sentMessages.filter((m) => m.handle === 'term_shell')).toHaveLength(0)
  })

  it('restores its own workers across a restart, keyed by handle not run id', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.fleetGrantCoversTargets = false

    const first = db.createTask({ spec: 'first' })
    await runBriefly(
      new Coordinator(db, runtime, { spec: 'go', coordinatorHandle: 'coord', pollIntervalMs: 20 })
    )
    const created = runtime.createdTerminals[0]
    expect(created).toBeDefined()
    // Free the worker, or it stays busy and would be skipped for reasons that
    // have nothing to do with ownership.
    insertWorkerDone(db, { taskId: first.id, from: created })

    // Baseline BEFORE the restart, or run 1's own messages make this pass no
    // matter what run 2 does.
    const beforeRestart = runtime.sentMessages.filter((m) => m.handle === created).length

    // A restart: `orchestration.run` mints a NEW run row every time, so ownership
    // keyed on run id would restore nothing and the fleet would re-adopt its own
    // worker through the same weak path as a stranger's pane.
    db.createTask({ spec: 'second' })
    await runBriefly(
      new Coordinator(db, runtime, { spec: 'go', coordinatorHandle: 'coord', pollIntervalMs: 20 })
    )

    // THE claim: with no grant covering anything, the only way this handle can be
    // dispatched to is if ownership survived the restart. Before the handle-keyed
    // ledger this was silently empty — the new run id matched zero events.
    expect(runtime.sentMessages.filter((m) => m.handle === created).length).toBeGreaterThan(
      beforeRestart
    )
    // Deliberately not asserting the terminal count: the first worker is still
    // holding the incomplete first task, so spawning a second one is correct.
  })
})
