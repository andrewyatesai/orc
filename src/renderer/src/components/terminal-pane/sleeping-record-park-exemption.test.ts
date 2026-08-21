import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { selectSleepingRecordParkExemptTabIds } from './sleeping-record-park-exemption'

const WORKTREE_ID = 'repo-1::/tmp/wt'

function makeRecord(overrides: Partial<SleepingAgentSessionRecord>): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('selectSleepingRecordParkExemptTabIds', () => {
  it('exempts the tab of a consumable record for the target worktree', () => {
    const record = makeRecord({})
    const exempt = selectSleepingRecordParkExemptTabIds({ [record.paneKey]: record }, WORKTREE_ID)
    expect(exempt.has('tab-1')).toBe(true)
  })

  // Why: a parked pane can never cold-restore; exempting a foreign-worktree
  // record here would pin an unrelated tab mounted.
  it('ignores records for other worktrees', () => {
    const record = makeRecord({ worktreeId: 'repo-1::/tmp/other' })
    const exempt = selectSleepingRecordParkExemptTabIds({ [record.paneKey]: record }, WORKTREE_ID)
    expect(exempt.size).toBe(0)
  })

  // Why: passive-completed evidence never resumes in place (fresh-tab activation
  // owns its --resume), so exempting it would pin a hidden pane mounted forever.
  it('does not exempt passive-completed evidence a mount cannot consume', () => {
    const record = makeRecord({ origin: 'worktree-sleep', state: 'done' })
    const exempt = selectSleepingRecordParkExemptTabIds({ [record.paneKey]: record }, WORKTREE_ID)
    expect(exempt.size).toBe(0)
  })

  it('derives the tab id from the pane key when the record omits it', () => {
    const record = makeRecord({ paneKey: 'tab-9:leaf-1', tabId: undefined })
    const exempt = selectSleepingRecordParkExemptTabIds({ [record.paneKey]: record }, WORKTREE_ID)
    expect(exempt.has('tab-9')).toBe(true)
  })

  it('returns an empty set for no records', () => {
    expect(selectSleepingRecordParkExemptTabIds(undefined, WORKTREE_ID).size).toBe(0)
  })
})
