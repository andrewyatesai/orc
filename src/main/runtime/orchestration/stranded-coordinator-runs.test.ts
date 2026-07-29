import { describe, expect, it, vi } from 'vitest'
import { failStrandedCoordinatorRuns } from './stranded-coordinator-runs'
import type { CoordinatorRun, OrchestrationDb } from './db'

function run(id: string, handle = 'coordinator'): CoordinatorRun {
  return {
    id,
    spec: 'spec',
    status: 'running',
    coordinator_handle: handle,
    poll_interval_ms: 1000,
    created_at: '2026-01-01 00:00:00',
    completed_at: null
  } as CoordinatorRun
}

function stubDb(active: CoordinatorRun[], overrides: Partial<OrchestrationDb> = {}) {
  const updateCoordinatorRun = vi.fn()
  return {
    db: {
      getActiveCoordinatorRuns: vi.fn(() => active),
      updateCoordinatorRun,
      ...overrides
    } as unknown as OrchestrationDb,
    updateCoordinatorRun
  }
}

describe('failStrandedCoordinatorRuns', () => {
  it('fails every run still marked running after a restart', () => {
    // Why: the live-coordinator registry is in-memory, so these rows have no loop behind
    // them. Left alone a fleet view reports the mission as running forever.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, updateCoordinatorRun } = stubDb([run('run_1'), run('run_2', 'other')])

    const failed = failStrandedCoordinatorRuns(db)

    expect(failed.map((entry) => entry.id)).toEqual(['run_1', 'run_2'])
    expect(updateCoordinatorRun).toHaveBeenNthCalledWith(1, 'run_1', 'failed')
    expect(updateCoordinatorRun).toHaveBeenNthCalledWith(2, 'run_2', 'failed')
    vi.restoreAllMocks()
  })

  it('is a silent no-op when nothing is stranded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, updateCoordinatorRun } = stubDb([])

    expect(failStrandedCoordinatorRuns(db)).toEqual([])
    expect(updateCoordinatorRun).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('survives a scan failure without taking orchestration down', () => {
    // Why: this runs inside lazy DB construction; throwing would break every caller.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = {
      getActiveCoordinatorRuns: vi.fn(() => {
        throw new Error('db locked')
      })
    } as unknown as OrchestrationDb

    expect(() => failStrandedCoordinatorRuns(db)).not.toThrow()
    expect(failStrandedCoordinatorRuns(db)).toEqual([])
    vi.restoreAllMocks()
  })

  it('keeps reaping after one row fails to update', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const updateCoordinatorRun = vi.fn((id: string) => {
      if (id === 'run_1') {
        throw new Error('write conflict')
      }
    })
    const db = {
      getActiveCoordinatorRuns: vi.fn(() => [run('run_1'), run('run_2')]),
      updateCoordinatorRun
    } as unknown as OrchestrationDb

    expect(failStrandedCoordinatorRuns(db).map((entry) => entry.id)).toEqual(['run_2'])
    expect(updateCoordinatorRun).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })
})
