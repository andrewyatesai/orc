import { describe, expect, it } from 'vitest'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'
import type { TerminalTab } from '../../../../shared/types'
import {
  retryDirectSshTerminalPanes,
  retrySettledDirectSshTerminalPane
} from './direct-ssh-pane-retry-ledger'
import type {
  DirectSshPaneRetryAttemptId,
  DirectSshTerminalBindingState
} from './direct-ssh-terminal-recovery-types'

const KEY = 'wt-ssh'
const attemptId = 'attempt-seed' as DirectSshPaneRetryAttemptId

function authority(epoch = 'epoch-1', generation = 1): DirectSshAuthority {
  return {
    targetId: 'target',
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: generation
  }
}

function makeTab(id: string, ptyId: string | null, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: KEY,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

type RetryState = DirectSshTerminalBindingState & {
  deferredSshSessionIdsByTabId: Record<string, string>
  terminalLayoutsByTabId?: Record<string, never>
}

function state(tabs: TerminalTab[], overrides: Partial<RetryState> = {}): RetryState {
  return {
    tabsByWorktree: { [KEY]: tabs },
    ptyIdsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    directSshPaneRetryByTabId: {},
    directSshLivePtyBindingByTabId: {},
    directSshPaneRetryHistoryByTabId: {},
    deferredSshSessionIdsByTabId: {},
    ...overrides
  }
}

describe('retryDirectSshTerminalPanes', () => {
  it('remounts a stranded pane: bumps generation, records the attempt and history', () => {
    const result = retryDirectSshTerminalPanes(
      state([makeTab('t1', null)]),
      new Set([KEY]),
      authority(),
      1000
    )
    expect(result.retriedCount).toBe(1)
    const tab = result.patch?.tabsByWorktree?.[KEY][0]
    expect(tab?.generation).toBe(1)
    expect(tab?.pendingActivationSpawn).toBe(true)
    expect(result.patch?.directSshPaneRetryByTabId?.t1.tabGeneration).toBe(1)
    expect(result.patch?.directSshPaneRetryHistoryByTabId?.t1.attemptedAt).toEqual([1000])
  })

  it('does not re-retry while a pending attempt for the same authority is outstanding', () => {
    const seeded = retryDirectSshTerminalPanes(
      state([makeTab('t1', null)]),
      new Set([KEY]),
      authority(),
      1000
    )
    const next = retryDirectSshTerminalPanes(
      { ...state([]), ...seeded.patch, deferredSshSessionIdsByTabId: {} } as RetryState,
      new Set([KEY]),
      authority(),
      2000
    )
    expect(next.retriedCount).toBe(0)
  })

  it('bounds the automatic fan-out at two attempts per authority', () => {
    const atCap = state([makeTab('t1', null)], {
      directSshPaneRetryHistoryByTabId: {
        t1: { authority: authority(), attemptedAt: [10, 20] }
      }
    })
    expect(retryDirectSshTerminalPanes(atCap, new Set([KEY]), authority(), 3000).retriedCount).toBe(0)

    const underCap = state([makeTab('t1', null)], {
      directSshPaneRetryHistoryByTabId: {
        t1: { authority: authority(), attemptedAt: [10] }
      }
    })
    const second = retryDirectSshTerminalPanes(underCap, new Set([KEY]), authority(), 3000)
    expect(second.retriedCount).toBe(1)
    expect(second.patch?.directSshPaneRetryHistoryByTabId?.t1.attemptedAt).toEqual([10, 3000])
  })

  it('isolates panes: one at the cap does not stop another under it', () => {
    const s = state([makeTab('capped', null), makeTab('fresh', null)], {
      directSshPaneRetryHistoryByTabId: {
        capped: { authority: authority(), attemptedAt: [1, 2] }
      }
    })
    const result = retryDirectSshTerminalPanes(s, new Set([KEY]), authority(), 4000)
    expect(result.retriedCount).toBe(1)
    expect(result.patch?.directSshPaneRetryByTabId?.fresh).toBeDefined()
    expect(result.patch?.directSshPaneRetryByTabId?.capped).toBeUndefined()
  })

  it('resets the budget when the authority rotates (a fresh connection incarnation)', () => {
    const s = state([makeTab('t1', null)], {
      directSshPaneRetryHistoryByTabId: {
        t1: { authority: authority('epoch-1', 1), attemptedAt: [1, 2] }
      }
    })
    const rotated = authority('epoch-2', 2)
    const result = retryDirectSshTerminalPanes(s, new Set([KEY]), rotated, 5000)
    expect(result.retriedCount).toBe(1)
    expect(result.patch?.directSshPaneRetryHistoryByTabId?.t1.attemptedAt).toEqual([5000])
  })

  it('skips a pane already recovered under the current authority (matching live binding)', () => {
    const boundPty = 'target@@pty-live'
    const s = state([makeTab('t1', boundPty, { generation: 2 })], {
      ptyIdsByTabId: { t1: [boundPty] },
      directSshLivePtyBindingByTabId: {
        t1: { attemptId, authority: authority(), tabGeneration: 2, ptyId: boundPty }
      }
    })
    const result = retryDirectSshTerminalPanes(s, new Set([KEY]), authority(), 6000)
    expect(result.retriedCount).toBe(0)
    expect(result.patch).toBeNull()
  })

  it('retrySettledDirectSshTerminalPane scopes recovery to a single tab', () => {
    const s = state([makeTab('t1', null), makeTab('t2', null)])
    const result = retrySettledDirectSshTerminalPane(s, new Set([KEY]), authority(), 't2', 7000)
    expect(result.retriedCount).toBe(1)
    expect(result.patch?.directSshPaneRetryByTabId?.t2).toBeDefined()
    expect(result.patch?.directSshPaneRetryByTabId?.t1).toBeUndefined()
  })
})
