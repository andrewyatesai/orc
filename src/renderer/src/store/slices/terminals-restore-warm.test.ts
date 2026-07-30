import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

// Intercepts reconnectPersistedTerminals' dynamic import of the warm module.
const { warmForRestore } = vi.hoisted(() => ({ warmForRestore: vi.fn() }))
vi.mock('@/lib/pane-manager/aterm/aterm-session-restore-warm', () => ({
  warmAtermEngineForSessionRestore: warmForRestore
}))

// @ts-expect-error -- mocked browser preload API (the actions under test issue no IPC)
globalThis.window = { api: {} }

import type { WorkspaceSessionState } from '../../../../shared/types'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/wt-1'

function restoredSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: 'tab-1',
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID, ptyId: 'pty-1' })]
    },
    terminalLayoutsByTabId: { 'tab-1': makeLayout() },
    activeWorktreeIdsOnShutdown: [WORKTREE_ID]
  }
}

beforeEach(() => {
  warmForRestore.mockClear()
})

describe('reconnectPersistedTerminals aterm restore warm', () => {
  it('kicks the warm with the PRE-clear snapshot when a session restores terminals', async () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
      }
    })
    store.getState().hydrateWorkspaceSession(restoredSession())
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([WORKTREE_ID])

    await store.getState().reconnectPersistedTerminals()

    // The warm module loads via dynamic import — resolve past it.
    await vi.waitFor(() => expect(warmForRestore).toHaveBeenCalledTimes(1))
    // The action clears pendingReconnect* at its end; the warm decision must
    // have seen the state captured BEFORE that clear.
    expect(warmForRestore.mock.calls[0][0].pendingReconnectWorktreeIds).toEqual([WORKTREE_ID])
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([])
    expect(store.getState().workspaceSessionReady).toBe(true)
  })

  it('never touches the warm module when nothing is pending reconnect', async () => {
    const store = createTestStore()
    seedStore(store, {})

    await store.getState().reconnectPersistedTerminals()
    // Give a would-be stray dynamic import time to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(warmForRestore).not.toHaveBeenCalled()
    expect(store.getState().workspaceSessionReady).toBe(true)
  })
})
