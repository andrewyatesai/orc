import { describe, expect, it } from 'vitest'
import {
  describeReconciliation,
  parseTaskClaim,
  reconcileTaskClaim
} from './task-claim-reconciliation'

describe('reconcileTaskClaim', () => {
  const completed = (files: string[]) =>
    JSON.stringify({ completedBy: 'w1', filesModified: files, completedAt: 'now' })

  it('is the alert that can contradict an agent', () => {
    // The whole reason this exists: a task claiming work git cannot see.
    const result = reconcileTaskClaim({
      taskStatus: 'completed',
      result: completed(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      changedFiles: []
    })
    expect(result).toMatchObject({ verdict: 'mismatch', missing: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })
  })

  it('matches when the claim is true', () => {
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: completed(['src/a.ts']),
        changedFiles: ['src/a.ts']
      })
    ).toMatchObject({ verdict: 'match' })
  })

  it('normalizes path shape, so ./a.ts and a.ts are one file', () => {
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: completed(['./src/a.ts']),
        changedFiles: ['src/a.ts']
      })
    ).toMatchObject({ verdict: 'match' })
  })

  it('reports files changed but never claimed', () => {
    const result = reconcileTaskClaim({
      taskStatus: 'completed',
      result: completed(['src/a.ts']),
      changedFiles: ['src/a.ts', 'src/surprise.ts']
    })
    expect(result).toMatchObject({ verdict: 'mismatch', unclaimed: ['src/surprise.ts'], missing: [] })
  })

  it('degrades to unknown with no git — NEVER to mismatch', () => {
    // On a folder workspace an absent answer is not a discrepancy. Crying
    // mismatch here would train a supervisor to ignore the alert.
    const result = reconcileTaskClaim({
      taskStatus: 'completed',
      result: completed(['src/a.ts']),
      changedFiles: null
    })
    expect(result).toEqual({ verdict: 'unknown', reason: 'no-git' })
    expect(describeReconciliation(result)).not.toContain('mismatch')
  })

  it.each([
    ['a task still running', 'dispatched', completed([])],
    ['an unreadable result', 'completed', 'not json'],
    ['no result at all', 'completed', null]
  ])('is unknown for %s', (_label, status, result) => {
    expect(reconcileTaskClaim({ taskStatus: status, result, changedFiles: [] }).verdict).toBe(
      'unknown'
    )
  })

  it('a completed task claiming nothing, with nothing changed, is a match not a mismatch', () => {
    expect(
      reconcileTaskClaim({ taskStatus: 'completed', result: completed([]), changedFiles: [] })
    ).toMatchObject({ verdict: 'match' })
  })
})

describe('parseTaskClaim', () => {
  it('drops non-string entries rather than trusting the shape', () => {
    const claim = parseTaskClaim(JSON.stringify({ filesModified: ['a.ts', 42, null] }))
    expect(claim?.filesModified).toEqual(['a.ts'])
  })

  it('returns null for anything unparseable', () => {
    expect(parseTaskClaim('nope')).toBeNull()
    expect(parseTaskClaim(null)).toBeNull()
    expect(parseTaskClaim('"a string"')).toBeNull()
  })
})
