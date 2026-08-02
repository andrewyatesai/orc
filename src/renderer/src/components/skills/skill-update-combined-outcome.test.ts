import { describe, expect, it } from 'vitest'
import type { SkillUpdateRun } from '../../../../shared/skill-freshness'
import type { OfflineSkillUpdateRun } from './skill-offline-update-run'
import { combineSkillUpdateOutcome } from './skill-update-combined-outcome'

const NPX_IDLE: SkillUpdateRun = { state: 'idle' }
const OFFLINE_IDLE: OfflineSkillUpdateRun = { names: [], running: false, failedNames: [] }

function npxRunning(names: string[]): SkillUpdateRun {
  return { state: 'running', names, startedAt: 1, output: '' }
}

function npxSuccess(names: string[]): SkillUpdateRun {
  return { state: 'success', names, finishedAt: 2, output: 'done' }
}

function npxError(names: string[], failedNames: string[]): SkillUpdateRun {
  return {
    state: 'error',
    names,
    finishedAt: 3,
    output: '',
    message: 'skills update exited with code 1',
    failedNames
  }
}

function offlineRunning(names: string[]): OfflineSkillUpdateRun {
  return { names, running: true, failedNames: [] }
}

function offlineFinished(names: string[], failedNames: string[] = []): OfflineSkillUpdateRun {
  return { names, running: false, failedNames }
}

describe('combineSkillUpdateOutcome', () => {
  it('holds a mixed batch whose npx rail was dispatched but has not reported yet', () => {
    // An unreported run is `idle`, not `running` — without the dispatch record the
    // bundled write alone would announce a batch the other rail has not begun.
    const outcome = combineSkillUpdateOutcome(NPX_IDLE, offlineFinished(['orchestration']), {
      npx: true,
      offline: true
    })
    expect(outcome.settled).toBe(false)
  })

  it('holds a mixed batch whose bundled rail was dispatched but has not reported yet', () => {
    const outcome = combineSkillUpdateOutcome(npxSuccess(['orca-cli']), OFFLINE_IDLE, {
      npx: true,
      offline: true
    })
    expect(outcome.settled).toBe(false)
  })

  it('holds the batch while the npx rail is still running after the bundled half landed', () => {
    const outcome = combineSkillUpdateOutcome(
      npxRunning(['orca-cli']),
      offlineFinished(['orchestration']),
      { npx: true, offline: true }
    )
    expect(outcome.settled).toBe(false)
  })

  it('holds the batch while the bundled rail is still writing after npx exited', () => {
    const outcome = combineSkillUpdateOutcome(
      npxSuccess(['orca-cli']),
      offlineRunning(['orchestration']),
      { npx: true, offline: true }
    )
    expect(outcome.settled).toBe(false)
  })

  it('settles a bundled-only press the npx runner was never handed', () => {
    // A single-rail update is legitimate: an untouched rail may not hold it open.
    const outcome = combineSkillUpdateOutcome(NPX_IDLE, offlineFinished(['orchestration']), {
      offline: true
    })
    expect(outcome.settled).toBe(true)
    expect(outcome.attemptedNames).toEqual(['orchestration'])
  })

  it('settles an npx-only press the bundled installer was never handed', () => {
    const outcome = combineSkillUpdateOutcome(npxSuccess(['orca-cli']), OFFLINE_IDLE, { npx: true })
    expect(outcome.settled).toBe(true)
    expect(outcome.attemptedNames).toEqual(['orca-cli'])
  })

  it('settles a single-rail press reported by a caller that keeps no dispatch record', () => {
    expect(combineSkillUpdateOutcome(NPX_IDLE, offlineFinished(['orchestration'])).settled).toBe(
      true
    )
    expect(combineSkillUpdateOutcome(npxSuccess(['orca-cli']), OFFLINE_IDLE).settled).toBe(true)
  })

  it('reports both rails once both have finished', () => {
    const outcome = combineSkillUpdateOutcome(
      npxSuccess(['orca-cli']),
      offlineFinished(['orchestration']),
      { npx: true, offline: true }
    )
    expect(outcome.settled).toBe(true)
    expect(outcome.failed).toBe(false)
    expect(outcome.attemptedNames).toEqual(['orca-cli', 'orchestration'])
  })

  it('counts the bundled half of a batch whose npx half failed', () => {
    const outcome = combineSkillUpdateOutcome(
      npxError(['orca-cli'], ['orca-cli']),
      offlineFinished(['orchestration']),
      { npx: true, offline: true }
    )
    expect(outcome.settled).toBe(true)
    expect(outcome.failed).toBe(true)
    expect(outcome.failedNpxNames).toEqual(['orca-cli'])
    expect(outcome.attemptedNames).toEqual(['orca-cli', 'orchestration'])
  })

  it('keeps a refused bundled write out of a success headline', () => {
    const outcome = combineSkillUpdateOutcome(
      npxSuccess(['orca-cli']),
      offlineFinished(['orchestration'], ['orchestration']),
      { npx: true, offline: true }
    )
    expect(outcome.settled).toBe(true)
    expect(outcome.failed).toBe(true)
    expect(outcome.failedOfflineNames).toEqual(['orchestration'])
  })

  it('still reports a non-zero exit whose re-scan found every name converged', () => {
    const outcome = combineSkillUpdateOutcome(npxError(['orca-cli'], []), OFFLINE_IDLE, {
      npx: true
    })
    expect(outcome.settled).toBe(true)
    expect(outcome.failedNpxNames).toEqual([])
    // The message is the whole point: `skills update` can exit non-zero having
    // converged everything, and the user still has to read it.
    expect(outcome.failed).toBe(true)
  })

  it('has nothing to report before either rail takes work', () => {
    expect(combineSkillUpdateOutcome(NPX_IDLE, OFFLINE_IDLE).settled).toBe(false)
    expect(
      combineSkillUpdateOutcome(NPX_IDLE, OFFLINE_IDLE, { npx: true, offline: true }).settled
    ).toBe(false)
  })
})
