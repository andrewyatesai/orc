import { describe, expect, it } from 'vitest'
import type { DirectSshAuthority, SshConnectionState, SshProviderEpoch } from '../../../../shared/ssh-types'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

const TARGET = 'target'
const WT = 'target-repo::/work'

function authority(epoch = 'epoch-1', generation = 1): DirectSshAuthority {
  return {
    targetId: TARGET,
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: generation
  }
}

function connectionState(epoch = 'epoch-1', generation = 1): SshConnectionState {
  return {
    targetId: TARGET,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: generation
  }
}

function seed(
  store: ReturnType<typeof createTestStore>,
  tabPtyId: string | null,
  connection: SshConnectionState = connectionState()
): void {
  store.setState({
    repos: [
      {
        id: 'target-repo',
        path: '/work',
        displayName: 'demo',
        badgeColor: '#000',
        addedAt: 1,
        connectionId: TARGET,
        executionHostId: 'ssh:target'
      }
    ],
    worktreesByRepo: {
      'target-repo': [makeWorktree({ id: WT, repoId: 'target-repo', hostId: 'ssh:target' })]
    },
    tabsByWorktree: {
      [WT]: [makeTab({ id: 'tab-1', worktreeId: WT, ptyId: tabPtyId })]
    },
    ptyIdsByTabId: tabPtyId ? { 'tab-1': [tabPtyId] } : {},
    sshConnectionStates: new Map([[TARGET, connection]])
  })
}

describe('terminal recovery store actions', () => {
  it('retryDirectSshTargetPanes remounts a stranded pane under the current authority', () => {
    const store = createTestStore()
    seed(store, null)
    const retried = store.getState().retryDirectSshTargetPanes(authority())
    expect(retried).toBe(1)
    const tab = store.getState().tabsByWorktree[WT][0]
    expect(tab.generation).toBe(1)
    expect(store.getState().directSshPaneRetryByTabId['tab-1']).toBeDefined()
    expect(store.getState().directSshPaneRetryHistoryByTabId['tab-1'].attemptedAt).toHaveLength(1)
  })

  it('ignores a retry whose authority no longer matches the target connection', () => {
    const store = createTestStore()
    seed(store, null)
    const retried = store.getState().retryDirectSshTargetPanes(authority('stale-epoch', 1))
    expect(retried).toBe(0)
    expect(store.getState().tabsByWorktree[WT][0].generation).toBeUndefined()
  })

  it('does nothing for a target that owns no terminal workspaces', () => {
    const store = createTestStore()
    seed(store, null)
    store.setState({ repos: [] })
    expect(store.getState().retryDirectSshTargetPanes(authority())).toBe(0)
  })

  it('clearDirectSshTargetPtyBindings nulls every live PTY the target owns', () => {
    const store = createTestStore()
    seed(store, 'target@@pty-1')
    const cleared = store.getState().clearDirectSshTargetPtyBindings(TARGET)
    expect(cleared).toBe(1)
    expect(store.getState().tabsByWorktree[WT][0].ptyId).toBeNull()
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
  })

  it('invalidateStaleDirectSshTargetPtyBindings clears a PTY with no matching live binding', () => {
    const store = createTestStore()
    seed(store, 'target@@pty-1')
    const cleared = store.getState().invalidateStaleDirectSshTargetPtyBindings(authority())
    expect(cleared).toBe(1)
    expect(store.getState().tabsByWorktree[WT][0].ptyId).toBeNull()
  })
})
