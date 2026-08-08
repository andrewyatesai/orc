import { describe, expect, it } from 'vitest'
import {
  EXCEPTION_SOURCE_STATUS,
  collapseExceptionsByTask,
  unwiredExceptionSources,
  type FleetException
} from './fleet-exceptions'

function exception(overrides: Partial<FleetException> = {}): FleetException {
  return {
    taskId: 'task-1',
    kind: 'escalation',
    summary: 'something',
    workerHandle: 'w1',
    attempts: 1,
    at: '2026-08-07T10:00:00Z',
    ...overrides
  }
}

describe('collapseExceptionsByTask', () => {
  it('collapses a retry storm into ONE row carrying the attempt count', () => {
    // The real shape: a deterministic failure emits escalation -> retry ->
    // escalation -> retry -> escalation -> circuit_broken in ~10s. Six rows for
    // one problem makes the queue unreadable exactly when it matters.
    const storm = [
      exception({ kind: 'escalation', at: '2026-08-07T10:00:00Z' }),
      exception({ kind: 'escalation', at: '2026-08-07T10:00:03Z' }),
      exception({ kind: 'escalation', at: '2026-08-07T10:00:06Z' }),
      exception({ kind: 'circuit-broken', at: '2026-08-07T10:00:09Z' })
    ]
    const collapsed = collapseExceptionsByTask(storm)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].attempts).toBe(4)
    // The most severe kind represents the task, not the earliest one.
    expect(collapsed[0].kind).toBe('circuit-broken')
  })

  it('keeps distinct tasks distinct', () => {
    const collapsed = collapseExceptionsByTask([
      exception({ taskId: 'a' }),
      exception({ taskId: 'b' })
    ])
    expect(collapsed).toHaveLength(2)
  })

  it('orders by severity before recency — an old circuit-break outranks a new escalation', () => {
    // The older one is the one that will never resolve itself: the breaker means
    // the fleet has STOPPED retrying.
    const collapsed = collapseExceptionsByTask([
      exception({ taskId: 'new', kind: 'escalation', at: '2026-08-07T12:00:00Z' }),
      exception({ taskId: 'old', kind: 'circuit-broken', at: '2026-08-07T09:00:00Z' })
    ])
    expect(collapsed.map((entry) => entry.taskId)).toEqual(['old', 'new'])
  })

  it('puts a gate first — it is the only state blocking on this specific person', () => {
    const collapsed = collapseExceptionsByTask([
      exception({ taskId: 'broken', kind: 'circuit-broken' }),
      exception({ taskId: 'gated', kind: 'gate' })
    ])
    expect(collapsed[0].taskId).toBe('gated')
  })

  it('collapses before ordering, so severity cannot be lost to sort order', () => {
    // If ordering came first, the earliest escalation could represent the task
    // and the circuit-break would be dropped as a duplicate.
    const collapsed = collapseExceptionsByTask([
      exception({ taskId: 't', kind: 'escalation', at: '2026-08-07T09:00:00Z' }),
      exception({ taskId: 't', kind: 'gate', at: '2026-08-07T08:00:00Z' })
    ])
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].kind).toBe('gate')
  })

  it('is empty for no input', () => {
    expect(collapseExceptionsByTask([])).toEqual([])
  })
})

describe('source honesty', () => {
  it('names every source §8.3 requires', () => {
    expect(Object.keys(EXCEPTION_SOURCE_STATUS).sort()).toEqual(
      [
        'attention',
        'circuit-broken',
        'escalation',
        'gate',
        'lifecycle-rejected',
        'unanswered-ask'
      ].sort()
    )
  })

  it('reports which sources are not wired, so an empty queue is never mistaken for "all clear"', () => {
    // A supervisor who believes the queue covers all six will read an empty one
    // as "nothing is wrong" — the exact failure the queue exists to prevent.
    expect(unwiredExceptionSources().length).toBeGreaterThan(0)
    expect(EXCEPTION_SOURCE_STATUS.gate).toBe('wired')
  })
})
