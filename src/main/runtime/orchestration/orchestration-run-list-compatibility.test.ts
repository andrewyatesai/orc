import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  orchestrationSqliteProbe,
  type OrchestrationSqliteProbe
} from './orchestration-sqlite-probe'
import { ORCHESTRATION_RUN_METHODS } from '../rpc/methods/orchestration-runs'

// The fork's store is in Rust; raw SQL goes through the spec probe.
function sqliteFor(db: OrchestrationDb): OrchestrationSqliteProbe {
  return orchestrationSqliteProbe(db)
}

describe('orchestration Run list compatibility', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('rejects malformed pagination cursors', () => {
    const method = ORCHESTRATION_RUN_METHODS.find(
      (candidate) => candidate.name === 'orchestration.runList'
    )!

    expect(() => method.params!.parse({ cursor: {} })).toThrow()
    expect(() => method.params!.parse({ cursor: '' })).toThrow()
  })

  it('preserves the unpaginated RPC result for an old client request', async () => {
    db = new OrchestrationDb(':memory:')
    const runCount = 101
    sqliteFor(db)
      .prepare(
        `WITH RECURSIVE run_numbers(value) AS (
           VALUES (1)
           UNION ALL
           SELECT value + 1 FROM run_numbers WHERE value < ?
         )
         INSERT INTO runs (id, objective)
         SELECT printf('run_compat_%03d', value), printf('Run %03d', value)
         FROM run_numbers`
      )
      .run(runCount)
    const method = ORCHESTRATION_RUN_METHODS.find(
      (candidate) => candidate.name === 'orchestration.runList'
    )!
    const params = method.params!.parse({})
    const result = (await method.handler(params, {
      runtime: { getOrchestrationDb: () => db }
    } as never)) as { runs: unknown[] }

    expect(result.runs).toHaveLength(runCount + 1)
  })
})
