import { describe, expect, it } from 'vitest'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'
import type { TerminalTab } from '../../../../shared/types'
import {
  directSshAuthoritiesEqual,
  liveBindingMatches,
  pruneObsoleteAuthorityState,
  withoutTabIds
} from './direct-ssh-terminal-authority-ledger'
import {
  clearDirectSshTerminalBindings,
  invalidateStaleDirectSshTerminalBindings
} from './direct-ssh-terminal-recovery'
import type {
  DirectSshLivePtyBinding,
  DirectSshPaneRetryAttempt,
  DirectSshPaneRetryAttemptId,
  DirectSshTerminalBindingState
} from './direct-ssh-terminal-recovery-types'

function authority(epoch = 'epoch-1', generation = 1): DirectSshAuthority {
  return {
    targetId: 'target',
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: generation
  }
}

const attemptId = 'attempt-1' as DirectSshPaneRetryAttemptId

function makeTab(id: string, ptyId: string | null, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'wt-ssh',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

function baseState(
  overrides: Partial<DirectSshTerminalBindingState> = {}
): DirectSshTerminalBindingState {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    directSshPaneRetryByTabId: {},
    directSshLivePtyBindingByTabId: {},
    directSshPaneRetryHistoryByTabId: {},
    ...overrides
  }
}

describe('direct SSH authority ledger primitives', () => {
  it('compares authorities by the full (target, epoch, generation) triple', () => {
    expect(directSshAuthoritiesEqual(authority(), authority())).toBe(true)
    expect(directSshAuthoritiesEqual(authority('a'), authority('b'))).toBe(false)
    expect(directSshAuthoritiesEqual(authority('a', 1), authority('a', 2))).toBe(false)
  })

  it('withoutTabIds is copy-on-write and leaves absent ids untouched', () => {
    const source = { a: 1, b: 2 }
    expect(withoutTabIds(source, new Set(['missing']))).toBe(source)
    const pruned = withoutTabIds(source, new Set(['a']))
    expect(pruned).toEqual({ b: 2 })
    expect(source).toEqual({ a: 1, b: 2 })
  })

  it('prunes only same-target rows captured under a superseded authority', () => {
    const current = authority('epoch-2', 2)
    const state = baseState({
      directSshPaneRetryHistoryByTabId: {
        stale: { authority: authority('epoch-1', 1), attemptedAt: [1] },
        current: { authority: current, attemptedAt: [2] },
        otherTarget: {
          authority: {
            targetId: 'other',
            providerEpoch: 'x' as SshProviderEpoch,
            connectionGeneration: 9
          },
          attemptedAt: [3]
        }
      }
    })
    const pruned = pruneObsoleteAuthorityState(state, current)
    expect(Object.keys(pruned.directSshPaneRetryHistoryByTabId).sort()).toEqual([
      'current',
      'otherTarget'
    ])
  })

  it('matches a live binding only under the same authority and tab generation', () => {
    const binding: DirectSshLivePtyBinding = {
      attemptId,
      authority: authority(),
      tabGeneration: 1,
      ptyId: 'target@@pty-1'
    }
    expect(
      liveBindingMatches(makeTab('t', 'target@@pty-1', { generation: 1 }), binding, authority())
    ).toBe(true)
    expect(
      liveBindingMatches(makeTab('t', 'target@@pty-1', { generation: 2 }), binding, authority())
    ).toBe(false)
    // a pending-activation pane with no ptyId still counts as bound
    expect(
      liveBindingMatches(
        makeTab('t', null, { generation: 1, pendingActivationSpawn: true }),
        binding,
        authority()
      )
    ).toBe(true)
    expect(
      liveBindingMatches(
        makeTab('t', 'target@@pty-1', { generation: 1 }),
        binding,
        authority('other')
      )
    ).toBe(false)
  })
})

describe('clearDirectSshTerminalBindings', () => {
  it('nulls scoped PTY ids and prunes their codex + retry ledger rows', () => {
    const state = baseState({
      tabsByWorktree: {
        'wt-ssh': [makeTab('live', 'target@@pty-1'), makeTab('idle', null)],
        'wt-other': [makeTab('untouched', 'target@@pty-9')]
      },
      ptyIdsByTabId: { live: ['target@@pty-1'], untouched: ['target@@pty-9'] },
      pendingCodexPaneRestartIds: { 'target@@pty-1': true },
      codexRestartNoticeByPtyId: {
        'target@@pty-1': { provider: 'codex', accountId: null } as never
      },
      directSshPaneRetryByTabId: {
        live: {
          attemptId,
          authority: authority(),
          tabGeneration: 0,
          startedAt: 1
        } as DirectSshPaneRetryAttempt
      }
    })
    const result = clearDirectSshTerminalBindings(state, new Set(['wt-ssh']))
    expect(result.clearedCount).toBe(1)
    const patch = result.patch
    expect(patch).not.toBeNull()
    expect(patch?.tabsByWorktree?.['wt-ssh'][0].ptyId).toBeNull()
    // out-of-scope workspace carries through unchanged
    expect(patch?.tabsByWorktree?.['wt-other'][0].ptyId).toBe('target@@pty-9')
    expect(patch?.ptyIdsByTabId?.live).toEqual([])
    expect(patch?.pendingCodexPaneRestartIds?.['target@@pty-1']).toBeUndefined()
    expect(patch?.directSshPaneRetryByTabId?.live).toBeUndefined()
  })

  it('returns a null patch when nothing in scope needs clearing', () => {
    const state = baseState({
      tabsByWorktree: { 'wt-ssh': [makeTab('idle', null)] }
    })
    expect(clearDirectSshTerminalBindings(state, new Set(['wt-ssh'])).patch).toBeNull()
  })
})

describe('invalidateStaleDirectSshTerminalBindings', () => {
  it('clears a PTY with no matching live binding but keeps one bound under the current authority', () => {
    const current = authority()
    const boundPty = 'target@@pty-keep'
    const state = baseState({
      tabsByWorktree: {
        'wt-ssh': [
          makeTab('stale', 'target@@pty-stale'),
          makeTab('bound', boundPty, { generation: 3 })
        ]
      },
      ptyIdsByTabId: { stale: ['target@@pty-stale'], bound: [boundPty] },
      directSshLivePtyBindingByTabId: {
        bound: { attemptId, authority: current, tabGeneration: 3, ptyId: boundPty }
      }
    })
    const result = invalidateStaleDirectSshTerminalBindings(state, new Set(['wt-ssh']), current)
    expect(result.clearedCount).toBe(1)
    const tabs = result.patch?.tabsByWorktree?.['wt-ssh'] ?? []
    expect(tabs.find((t) => t.id === 'stale')?.ptyId).toBeNull()
    expect(tabs.find((t) => t.id === 'bound')?.ptyId).toBe(boundPty)
    expect(result.patch?.directSshLivePtyBindingByTabId?.bound).toBeDefined()
  })

  it('prunes obsolete-authority ledger rows and preserves pending retries under the current authority', () => {
    const current = authority('epoch-2', 2)
    const state = baseState({
      tabsByWorktree: {
        'wt-ssh': [makeTab('pending', null, { generation: 5 })]
      },
      directSshPaneRetryByTabId: {
        pending: { attemptId, authority: current, tabGeneration: 5, startedAt: 1 },
        obsolete: { attemptId, authority: authority('epoch-1', 1), tabGeneration: 0, startedAt: 1 }
      }
    })
    const result = invalidateStaleDirectSshTerminalBindings(state, new Set(['wt-ssh']), current)
    expect(result.patch?.directSshPaneRetryByTabId?.pending).toBeDefined()
    expect(result.patch?.directSshPaneRetryByTabId?.obsolete).toBeUndefined()
  })
})
