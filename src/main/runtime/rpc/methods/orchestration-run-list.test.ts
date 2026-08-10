import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

type MockCoordinatorInstance = { resolveRun?: () => void }

// Why mocked: orchestration.run is the only way to populate the in-memory live
// registry runList reports on, and the real Coordinator would start a loop.
const coordinatorMock = vi.hoisted(() => {
  const instances: MockCoordinatorInstance[] = []

  class Coordinator {
    resolveRun?: () => void

    constructor() {
      instances.push(this)
    }

    runFromExistingRun(): Promise<unknown> {
      return new Promise((resolve) => {
        this.resolveRun = () => resolve({})
      })
    }

    stop(): void {
      this.resolveRun?.()
    }
  }

  return { Coordinator, instances }
})

vi.mock('../../orchestration/coordinator', () => ({
  Coordinator: coordinatorMock.Coordinator
}))

type RunTaskCounters = {
  completed: number
  failed: number
  blocked: number
  dispatched: number
  readyOrPending: number
  total: number
}

type RunListRow = {
  id: string
  status: string
  coordinator_handle: string
  created_at: string
  live: boolean
  tasks: RunTaskCounters
  pendingGates: number
}

type RunListResult = {
  runs: RunListRow[]
  count: number
  limit: number
  offset: number
  hasMore: boolean
}

describe('orchestration.runList', () => {
  let db: OrchestrationDb | undefined

  afterEach(async () => {
    for (const instance of coordinatorMock.instances) {
      instance.resolveRun?.()
    }
    coordinatorMock.instances.length = 0
    // Flush microtasks so the run handler's `.finally()` clears the module-scoped
    // live registry before the next test reads it.
    await Promise.resolve()
    await Promise.resolve()
    db?.close()
    db = undefined
  })

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    // Why the caller-scope stubs are no-ops: these tests are local callers,
    // which the real bounds return from before looking anything up.
    return method.handler(parsed, {
      runtime: {
        getOrchestrationDb: () => db,
        assertTerminalHandleInCallerScope: () => {},
        assertWorkspaceSelectorInCallerScope: async () => {}
      }
    } as never)
  }

  const runList = (params: Record<string, unknown> = {}) =>
    call('orchestration.runList', params) as Promise<RunListResult>

  it('returns runs newest first and pages with limit + offset', async () => {
    db = new OrchestrationDb(':memory:')
    const first = db.createCoordinatorRun({ spec: 'a', coordinatorHandle: 'coord-a' })
    const second = db.createCoordinatorRun({ spec: 'b', coordinatorHandle: 'coord-b' })
    const third = db.createCoordinatorRun({ spec: 'c', coordinatorHandle: 'coord-c' })

    const page = await runList({ limit: 2 })
    expect(page.runs.map((run) => run.id)).toEqual([third.id, second.id])
    expect(page).toMatchObject({ count: 2, limit: 2, offset: 0, hasMore: true })

    const tail = await runList({ limit: 2, offset: 2 })
    expect(tail.runs.map((run) => run.id)).toEqual([first.id])
    expect(tail.hasMore).toBe(false)
  })

  it('clamps an absurd or negative page request instead of scanning everything', async () => {
    db = new OrchestrationDb(':memory:')
    db.createCoordinatorRun({ spec: 'a', coordinatorHandle: 'coord-a' })

    await expect(runList({ limit: 10_000 })).resolves.toMatchObject({ limit: 100 })
    await expect(runList({ limit: 0, offset: -5 })).resolves.toMatchObject({ limit: 1, offset: 0 })
    await expect(runList({})).resolves.toMatchObject({ limit: 20, offset: 0 })
  })

  it('reports an empty history without inventing a run', async () => {
    db = new OrchestrationDb(':memory:')
    await expect(runList({})).resolves.toMatchObject({ runs: [], count: 0, hasMore: false })
  })

  it('splits counters per status so a failed task never counts as completed', async () => {
    db = new OrchestrationDb(':memory:')
    const done = db.createTask({ spec: 'done' })
    const broke = db.createTask({ spec: 'broke' })
    const stuck = db.createTask({ spec: 'stuck' })
    const busy = db.createTask({ spec: 'busy' })
    db.createTask({ spec: 'waiting' })
    // Adoption stamps this run onto every un-owned live task.
    const run = db.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord-a' })

    db.updateTaskStatus(done.id, 'completed')
    db.updateTaskStatus(broke.id, 'failed')
    db.updateTaskStatus(stuck.id, 'blocked')
    db.updateTaskStatus(busy.id, 'dispatched')

    const result = await runList({})
    expect(result.runs[0].id).toBe(run.id)
    expect(result.runs[0].tasks).toEqual({
      completed: 1,
      failed: 1,
      blocked: 1,
      dispatched: 1,
      readyOrPending: 1,
      total: 5
    })
  })

  it('counts each run separately instead of reusing one workspace-wide tally', async () => {
    db = new OrchestrationDb(':memory:')
    const oldTask = db.createTask({ spec: 'old work' })
    const oldRun = db.createCoordinatorRun({ spec: 'old', coordinatorHandle: 'coord-a' })
    db.updateTaskStatus(oldTask.id, 'failed')

    // First run takes all, so a later run owns only what it creates itself.
    const newRun = db.createCoordinatorRun({ spec: 'new', coordinatorHandle: 'coord-b' })
    const freshTask = db.createTask({ spec: 'new work', runId: newRun.id })
    db.updateTaskStatus(freshTask.id, 'completed')

    const byId = new Map((await runList({})).runs.map((run) => [run.id, run]))
    expect(byId.get(oldRun.id)?.tasks).toMatchObject({ failed: 1, completed: 0, total: 1 })
    expect(byId.get(newRun.id)?.tasks).toMatchObject({ completed: 1, failed: 0, total: 1 })
  })

  it('ignores un-owned legacy tasks rather than crediting them to a run', async () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord-a' })
    // Created after the adoption transaction and never stamped: run_id stays null.
    db.createTask({ spec: 'orphan' })

    const result = await runList({})
    expect(result.runs[0].id).toBe(run.id)
    expect(result.runs[0].tasks.total).toBe(0)
  })

  it('separates a live coordinator loop from a durable running row', async () => {
    db = new OrchestrationDb(':memory:')
    const stranded = db.createCoordinatorRun({ spec: 'pre-restart', coordinatorHandle: 'coord-a' })
    const started = (await call('orchestration.run', { spec: 'now', from: 'coord-b' })) as {
      runId: string
    }

    const byId = new Map((await runList({})).runs.map((run) => [run.id, run]))
    expect(byId.get(started.runId)).toMatchObject({ status: 'running', live: true })
    // Same durable status, no loop behind it — the distinction the caller needs.
    expect(byId.get(stranded.id)).toMatchObject({ status: 'running', live: false })
  })

  it('reports pending gates per run and drops them once resolved', async () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'needs a decision' })
    const run = db.createCoordinatorRun({ spec: 'mission', coordinatorHandle: 'coord-a' })
    const gate = db.createGate({ taskId: task.id, question: 'Ship?', runId: run.id })

    await expect(runList({})).resolves.toMatchObject({ runs: [{ pendingGates: 1 }] })

    db.resolveGate(gate.id, 'yes')
    await expect(runList({})).resolves.toMatchObject({ runs: [{ pendingGates: 0 }] })
  })
})

describe('run filters on orchestration.taskList and orchestration.gateList', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    // Why the caller-scope stubs are no-ops: these tests are local callers,
    // which the real bounds return from before looking anything up.
    return method.handler(parsed, {
      runtime: {
        getOrchestrationDb: () => db,
        assertTerminalHandleInCallerScope: () => {},
        assertWorkspaceSelectorInCallerScope: async () => {}
      }
    } as never)
  }

  function seedTwoRuns() {
    db = new OrchestrationDb(':memory:')
    const adopted = db.createTask({ spec: 'adopted' })
    const first = db.createCoordinatorRun({ spec: 'first', coordinatorHandle: 'coord-a' })
    const second = db.createCoordinatorRun({ spec: 'second', coordinatorHandle: 'coord-b' })
    const owned = db.createTask({ spec: 'owned by second', runId: second.id })
    const orphan = db.createTask({ spec: 'un-owned' })
    return { first, second, adopted, owned, orphan }
  }

  it('narrows taskList to one run and keeps the dispatch join', async () => {
    const { first, second, adopted, owned } = seedTwoRuns()
    db!.createDispatchContext(adopted.id, 'term_worker')
    db!.updateTaskStatus(adopted.id, 'dispatched')

    const firstRun = (await call('orchestration.taskList', { runId: first.id })) as {
      tasks: { id: string; assignee_handle?: string | null }[]
      count: number
    }
    expect(firstRun.tasks.map((task) => task.id)).toEqual([adopted.id])
    expect(firstRun.tasks[0].assignee_handle).toBe('term_worker')

    const secondRun = (await call('orchestration.taskList', { runId: second.id })) as {
      tasks: { id: string }[]
    }
    expect(secondRun.tasks.map((task) => task.id)).toEqual([owned.id])
  })

  it('treats an omitted run filter as no filter, not as un-owned only', async () => {
    const { adopted, owned, orphan } = seedTwoRuns()
    const all = (await call('orchestration.taskList', {})) as { tasks: { id: string }[] }
    expect(all.tasks.map((task) => task.id).sort()).toEqual(
      [adopted.id, owned.id, orphan.id].sort()
    )
  })

  it('combines the run filter with the status filter on taskList', async () => {
    const { first, adopted } = seedTwoRuns()
    db!.updateTaskStatus(adopted.id, 'failed')

    await expect(
      call('orchestration.taskList', { runId: first.id, status: 'completed' })
    ).resolves.toMatchObject({ count: 0 })
    await expect(
      call('orchestration.taskList', { runId: first.id, status: 'failed' })
    ).resolves.toMatchObject({ count: 1 })
  })

  it('narrows gateList to one run', async () => {
    const { first, second, adopted, owned } = seedTwoRuns()
    const firstGate = db!.createGate({ taskId: adopted.id, question: 'a?', runId: first.id })
    const secondGate = db!.createGate({ taskId: owned.id, question: 'b?', runId: second.id })

    const scoped = (await call('orchestration.gateList', { runId: first.id })) as {
      gates: { id: string }[]
      count: number
    }
    expect(scoped.gates.map((gate) => gate.id)).toEqual([firstGate.id])
    expect(scoped.count).toBe(1)

    const unscoped = (await call('orchestration.gateList', {})) as { gates: { id: string }[] }
    expect(unscoped.gates.map((gate) => gate.id).sort()).toEqual(
      [firstGate.id, secondGate.id].sort()
    )
  })
})
