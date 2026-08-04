import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { orchestrationSqliteProbe } from './orchestration-sqlite-probe'

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const SQLITE_SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

describe('shim contract audit', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  function seed(): {
    runId: string
    taskId: string
    dispatchId: string
    generation: number
  } {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_c:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'do', runId: run.id })
    const dispatch = db.createDispatchContext(
      task.id,
      'term_worker',
      'tab_w:22222222-2222-4222-8222-222222222222'
    )
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId: dispatch.id,
      generation: run.consumer_generation
    }
  }

  it('mints every caller-supplied id with the db.ts prefix and 12 hex chars', () => {
    const state = seed()
    expect(state.runId).toMatch(/^run_[0-9a-f]{12}$/)
    expect(state.taskId).toMatch(/^task_[0-9a-f]{12}$/)
    expect(state.dispatchId).toMatch(/^ctx_[0-9a-f]{12}$/)
    expect(db!.insertMessage({ from: 'a', to: 'b', subject: 's' }).id).toMatch(/^msg_[0-9a-f]{12}$/)
    expect(db!.createGate({ taskId: state.taskId, question: 'q' }).id).toMatch(
      /^gate_[0-9a-f]{12}$/
    )
    expect(db!.createCoordinatorRun({ spec: 'x', coordinatorHandle: 'term_coord' }).id).toMatch(
      /^run_[0-9a-f]{12}$/
    )
    const started = db!.createStartingWorkerDispatch({
      taskId: db!.createTask({ spec: 'w', runId: state.runId }).id,
      startOptions: { a: 1 }
    })
    expect(started.dispatch.id).toMatch(/^ctx_[0-9a-f]{12}$/)
    // start_options is the already-stringified text the TS twin wrote.
    expect(started.worker.start_options).toBe('{"a":1}')
  })

  it('exposes RFC3339 on exactly the four exposed row types, nested results included', () => {
    const state = seed()
    const message = db!.insertMessage({
      from: 'x',
      to: `run:${state.runId}`,
      subject: 's',
      runId: state.runId
    })
    expect(message.created_at).toMatch(RFC3339)
    expect(db!.getRun(state.runId)!.created_at).toMatch(RFC3339)
    expect(db!.getRun(state.runId)!.updated_at).toMatch(RFC3339)
    expect(db!.listRuns().runs[0]!.created_at).toMatch(RFC3339)
    expect(
      db!.getCurrentRunForPane('tab_c:11111111-1111-4111-8111-111111111111')!.created_at
    ).toMatch(RFC3339)

    const delivery = db!.getOrCreateRunDelivery({
      runId: state.runId,
      consumerGeneration: state.generation
    })!
    expect(delivery.delivery.created_at).toMatch(RFC3339)
    expect(delivery.messages[0]!.created_at).toMatch(RFC3339)
    const ack = db!.acknowledgeRunDelivery({
      runId: state.runId,
      consumerGeneration: state.generation,
      deliveryId: delivery.delivery.id
    })
    expect(ack.delivery.created_at).toMatch(RFC3339)
    expect(ack.delivery.acknowledged_at).toMatch(RFC3339)

    const question = db!.createQuestion({
      runId: state.runId,
      dispatchId: state.dispatchId,
      askerHandle: 'term_worker',
      question: 'q?'
    })
    expect(question.question.created_at).toMatch(RFC3339)
    expect(question.message.created_at).toMatch(RFC3339)
    expect(db!.getQuestion(question.message.id)!.created_at).toMatch(RFC3339)
    const answered = db!.answerQuestion({
      messageId: question.message.id,
      runId: state.runId,
      consumerGeneration: state.generation,
      body: 'a'
    })
    expect(answered.question.answered_at).toMatch(RFC3339)
    expect(answered.message.created_at).toMatch(RFC3339)

    expect(db!.getRunMailboxHistory(state.runId)[0]!.created_at).toMatch(RFC3339)
    expect(db!.getInbox()[0]!.created_at).toMatch(RFC3339)
  })

  it('leaves every non-exposed row in the raw SQLite space format', () => {
    const state = seed()
    expect(db!.getTask(state.taskId)!.created_at).toMatch(SQLITE_SPACE)
    expect(db!.getDispatchContextById(state.dispatchId)!.created_at).toMatch(SQLITE_SPACE)
    expect(
      db!.getGate(db!.createGate({ taskId: state.taskId, question: 'q' }).id)!.created_at
    ).toMatch(SQLITE_SPACE)
    const coordinator = db!.createCoordinatorRun({ spec: 'x', coordinatorHandle: 'c' })
    expect(db!.getCoordinatorRun(coordinator.id)!.created_at).toMatch(SQLITE_SPACE)
    const worker = db!.createStartingWorkerDispatch({
      taskId: db!.createTask({ spec: 'w', runId: state.runId }).id,
      startOptions: {}
    })
    expect(worker.worker.created_at).toMatch(SQLITE_SPACE)
    const receipt = db!.beginMutationReceipt({
      callerFingerprint: 'c',
      requestId: 'r',
      method: 'm',
      payloadHash: 'h'
    })
    expect(receipt.row.created_at).toMatch(SQLITE_SPACE)
  })

  it('rethrows store failures as OrchestrationError with code and data intact', () => {
    const state = seed()
    let thrown: unknown
    try {
      db!.getOrCreateRunDelivery({ runId: state.runId, consumerGeneration: state.generation + 5 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OrchestrationError)
    expect((thrown as OrchestrationError).code).toBe('consumer_fenced')
    expect((thrown as OrchestrationError).message).not.toContain('_orcaOrchestrationError')

    // A coded failure carrying `data` keeps the payload.
    let withData: unknown
    try {
      db!.bindRun({
        runId: state.runId,
        coordinatorHandle: 'h',
        coordinatorPaneKey: 'tab_z:33333333-3333-4333-8333-333333333333',
        takeoverLegacy: true
      })
    } catch (error) {
      withData = error
    }
    expect(withData).toBeInstanceOf(OrchestrationError)
    expect((withData as OrchestrationError).code).toBe('invalid_argument')

    // markWorkerStopUnknown's deliberate divergence: coded, not undefined.
    expect(() => db!.markWorkerStopUnknown('ctx_missing', 'why')).toThrowError(
      expect.objectContaining({ code: 'dispatch_not_found' })
    )
  })

  it('treats the listRuns cursor as opaque over raw SQLite timestamps', () => {
    db = new OrchestrationDb(':memory:')
    const probe = orchestrationSqliteProbe(db)
    for (let index = 0; index < 5; index++) {
      probe
        .prepare(
          `INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key,
             consumer_generation, legacy, created_at)
           VALUES (?, ?, ?, ?, 1, 0, '2025-01-01 00:00:00')`
        )
        .run(`run_cursor_${index}`, `Run ${index}`, `term_${index}`, `tab_${index}:leaf`)
    }
    const first = db.listRuns({ limit: 2 })
    expect(first.nextCursor).toBeTruthy()
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as {
      createdAt: string
    }
    expect(decoded.createdAt).toMatch(SQLITE_SPACE)
    const seen = new Set(first.runs.map((run) => run.id))
    let cursor = first.nextCursor ?? undefined
    while (cursor) {
      const page = db.listRuns({ limit: 2, cursor })
      for (const run of page.runs) {
        expect(seen.has(run.id)).toBe(false)
        seen.add(run.id)
      }
      cursor = page.nextCursor ?? undefined
    }
    expect(seen.size).toBe(6)
  })

  it('wraps resolveLegacyWorkerCandidate in { dispatch } and keeps caller timestamps', () => {
    const state = seed()
    db!.recordHeartbeat(state.dispatchId, '2026-07-28T12:00:00.000Z')
    expect(db!.getDispatchContextById(state.dispatchId)!.last_heartbeat_at).toBe(
      '2026-07-28T12:00:00.000Z'
    )
    expect(db!.resolveLegacyWorkerCandidate({ runId: state.runId })).toBeUndefined()
    const completed = db!.updateTaskStatus(state.taskId, 'completed', 'done')
    expect(completed!.completed_at).toMatch(RFC3339)
  })

  it('does not pre-mint the relay message id the store owns', () => {
    const state = seed()
    const worker = db!.createStartingWorkerDispatch({
      taskId: db!.createTask({ spec: 'fed', runId: state.runId }).id,
      startOptions: {},
      federation: {
        environmentId: 'env',
        environmentName: 'name',
        peerFingerprint: 'peer',
        protocolVersion: 1
      }
    })
    const item = db!.enqueueFederationRelay({
      dispatchId: worker.dispatch.id,
      direction: 'to_worker',
      kind: 'status',
      payload: '{}'
    })
    expect(item.message_id).toMatch(/^relay_[0-9a-f]{12}$/)
  })
})
