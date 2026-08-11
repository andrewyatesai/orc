import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'

// End-to-end idempotency through the RPC seam: a client-supplied idempotencyKey
// makes a retried mutating call apply ONCE and replay its recorded result; the
// same key with a different payload is a coded conflict.
describe('orchestration RPC mutation idempotency', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let dbOpen = false

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ctx = { runtime }
  }

  afterEach(() => {
    if (!dbOpen) {
      return
    }
    dbOpen = false
    db.close()
  })

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  it('taskCreate applies once and replays the receipt on a repeated key', async () => {
    setup()
    const params = {
      spec: 'ship it',
      callerTerminalHandle: 'term_coord',
      idempotencyKey: 'mk-1'
    }
    const first = (await call('orchestration.taskCreate', params)) as { task: { id: string } }
    const second = (await call('orchestration.taskCreate', params)) as { task: { id: string } }

    expect(second).toEqual(first) // identical receipt, not a fresh task id
    expect(db.listTasks().length).toBe(1) // one apply
  })

  it('rejects the same key with a different payload as a coded request_mismatch', async () => {
    setup()
    await call('orchestration.taskCreate', { spec: 'first', idempotencyKey: 'mk-2' })

    let caught: unknown
    try {
      await call('orchestration.taskCreate', { spec: 'second', idempotencyKey: 'mk-2' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OrchestrationError)
    expect((caught as OrchestrationError).code).toBe('request_mismatch')
    // The conflicting call never applied, and the pending slot was left intact.
    expect(db.listTasks().length).toBe(1)
  })

  it('leaves each call applying when no idempotencyKey is supplied (legacy path)', async () => {
    setup()
    await call('orchestration.taskCreate', { spec: 'a' })
    await call('orchestration.taskCreate', { spec: 'a' })
    expect(db.listTasks().length).toBe(2)
  })

  it('dispatch replays the first dispatch on retry without a second context', async () => {
    setup()
    const task = db.createTask({ spec: 'work' })
    const params = { task: task.id, to: 'term_a', from: 'term_coord', idempotencyKey: 'dk-1' }

    const first = (await call('orchestration.dispatch', params)) as { dispatch: { id: string } }
    // The task is now 'dispatched'; the replay must NOT re-run the ready-status
    // check, and must return the same context rather than minting a second one.
    const second = (await call('orchestration.dispatch', params)) as { dispatch: { id: string } }

    expect(second.dispatch.id).toBe(first.dispatch.id)
    expect(db.getDispatchContext(task.id)?.id).toBe(first.dispatch.id)
  })
})
