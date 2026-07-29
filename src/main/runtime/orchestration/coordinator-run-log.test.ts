import { describe, expect, it } from 'vitest'
import {
  COORDINATOR_RUN_LOG_LIMIT,
  CoordinatorRunLog,
  CoordinatorRunLogRegistry
} from './coordinator-run-log'

describe('CoordinatorRunLog', () => {
  it('keeps entries oldest-first, the order a human reads', () => {
    const log = new CoordinatorRunLog()
    log.append('first', 1)
    log.append('second', 2)
    expect(log.list().map((entry) => entry.message)).toEqual(['first', 'second'])
    expect(log.list()[0].at).toBe(1)
  })

  it('returns a copy so a caller cannot mutate the ring', () => {
    const log = new CoordinatorRunLog()
    log.append('only', 1)
    log.list().push({ at: 2, message: 'injected' })
    expect(log.size).toBe(1)
  })

  it('drops the oldest past the limit and counts what it dropped', () => {
    // Why count: a truncated tail that silently loses its head reads as "nothing happened
    // before this", which is exactly wrong while debugging a hang.
    const log = new CoordinatorRunLog(3)
    for (const message of ['a', 'b', 'c', 'd', 'e']) {
      log.append(message, 0)
    }
    expect(log.list().map((entry) => entry.message)).toEqual(['c', 'd', 'e'])
    expect(log.dropped).toBe(2)
    expect(log.size).toBe(3)
  })

  it('defaults to a bounded ring rather than unbounded growth', () => {
    const log = new CoordinatorRunLog()
    for (let index = 0; index < COORDINATOR_RUN_LOG_LIMIT + 25; index += 1) {
      log.append(`entry-${index}`, index)
    }
    expect(log.size).toBe(COORDINATOR_RUN_LOG_LIMIT)
    expect(log.dropped).toBe(25)
    expect(log.list()[0].message).toBe('entry-25')
  })
})

describe('CoordinatorRunLogRegistry', () => {
  it('returns the same log for a run and keeps runs isolated', () => {
    const registry = new CoordinatorRunLogRegistry()
    registry.forRun('run-1').append('one', 0)
    registry.forRun('run-1').append('two', 1)
    registry.forRun('run-2').append('other', 0)

    expect(registry.forRun('run-1').size).toBe(2)
    expect(
      registry
        .forRun('run-2')
        .list()
        .map((entry) => entry.message)
    ).toEqual(['other'])
  })

  it('peek does not create a log for an unknown run', () => {
    const registry = new CoordinatorRunLogRegistry()
    expect(registry.peek('nope')).toBeUndefined()
  })

  it('delete reaps a finished run so logs do not accumulate for the session', () => {
    const registry = new CoordinatorRunLogRegistry()
    registry.forRun('run-1').append('one', 0)
    registry.delete('run-1')
    expect(registry.peek('run-1')).toBeUndefined()
  })
})
