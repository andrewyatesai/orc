import { beforeEach, describe, expect, it, vi } from 'vitest'

const { warmSpy } = vi.hoisted(() => ({ warmSpy: vi.fn() }))
vi.mock('./aterm-worker-prewarm', () => ({
  warmAtermSharedWorkerForImminentPane: warmSpy
}))

import {
  resetSessionRestoreWarmForTest,
  sessionRestoreHasLocalTerminalPanes,
  warmAtermEngineForSessionRestore,
  type SessionRestoreWarmSnapshot
} from './aterm-session-restore-warm'

const LOCAL_WT = 'repo-local::/wt-local'
const SSH_WT = 'repo-ssh::/home/user/remote'

function makeSnapshot(
  overrides: Partial<SessionRestoreWarmSnapshot> = {}
): SessionRestoreWarmSnapshot {
  return {
    activeWorktreeId: null,
    pendingReconnectWorktreeIds: [],
    pendingReconnectTabByWorktree: {},
    tabsByWorktree: {},
    worktreesByRepo: {},
    repos: [],
    ...overrides
  }
}

function localRestoreSnapshot(): SessionRestoreWarmSnapshot {
  return makeSnapshot({
    activeWorktreeId: LOCAL_WT,
    pendingReconnectWorktreeIds: [LOCAL_WT],
    tabsByWorktree: { [LOCAL_WT]: [{ id: 'tab-1' }] },
    worktreesByRepo: { 'repo-local': [{ id: LOCAL_WT, repoId: 'repo-local' }] },
    repos: [{ id: 'repo-local', connectionId: null }]
  })
}

describe('sessionRestoreHasLocalTerminalPanes', () => {
  it('is true for a local ACTIVE worktree with a restorable tab', () => {
    expect(sessionRestoreHasLocalTerminalPanes(localRestoreSnapshot())).toBe(true)
  })

  it('is false with no pending reconnects', () => {
    expect(sessionRestoreHasLocalTerminalPanes(makeSnapshot())).toBe(false)
  })

  it('is false when the active worktree is not among the pending reconnects', () => {
    const snapshot = localRestoreSnapshot()
    snapshot.activeWorktreeId = 'repo-other::/elsewhere'
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('is false when no worktree is active', () => {
    const snapshot = localRestoreSnapshot()
    snapshot.activeWorktreeId = null
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('is false when the pending worktree has no tabs to restore', () => {
    const snapshot = makeSnapshot({
      activeWorktreeId: LOCAL_WT,
      pendingReconnectWorktreeIds: [LOCAL_WT],
      worktreesByRepo: { 'repo-local': [{ id: LOCAL_WT, repoId: 'repo-local' }] }
    })
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('is false when the targeted tab ids no longer exist', () => {
    const snapshot = localRestoreSnapshot()
    snapshot.pendingReconnectTabByWorktree = { [LOCAL_WT]: ['tab-gone'] }
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('is false for an SSH-only restore (worktree loaded)', () => {
    const snapshot = makeSnapshot({
      activeWorktreeId: SSH_WT,
      pendingReconnectWorktreeIds: [SSH_WT],
      tabsByWorktree: { [SSH_WT]: [{ id: 'tab-1' }] },
      worktreesByRepo: { 'repo-ssh': [{ id: SSH_WT, repoId: 'repo-ssh' }] },
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-target-1' }]
    })
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('is false for a cold-start SSH restore whose worktree is not in worktreesByRepo yet', () => {
    // The repo id embedded in the composite worktree id must resolve the SSH repo.
    const snapshot = makeSnapshot({
      activeWorktreeId: SSH_WT,
      pendingReconnectWorktreeIds: [SSH_WT],
      tabsByWorktree: { [SSH_WT]: [{ id: 'tab-1' }] },
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-target-1' }]
    })
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('is false for a runtime-hosted worktree', () => {
    const snapshot = makeSnapshot({
      activeWorktreeId: LOCAL_WT,
      pendingReconnectWorktreeIds: [LOCAL_WT],
      tabsByWorktree: { [LOCAL_WT]: [{ id: 'tab-1' }] },
      worktreesByRepo: {
        'repo-local': [{ id: LOCAL_WT, repoId: 'repo-local', hostId: 'runtime:env-1' }]
      },
      repos: [{ id: 'repo-local', connectionId: null }]
    })
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('is false when the repo itself is runtime-hosted', () => {
    const snapshot = makeSnapshot({
      activeWorktreeId: LOCAL_WT,
      pendingReconnectWorktreeIds: [LOCAL_WT],
      tabsByWorktree: { [LOCAL_WT]: [{ id: 'tab-1' }] },
      worktreesByRepo: { 'repo-local': [{ id: LOCAL_WT, repoId: 'repo-local' }] },
      repos: [{ id: 'repo-local', connectionId: null, executionHostId: 'runtime:env-1' }]
    })
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })

  it('treats an unresolvable worktree AND repo as local (floating terminal, folder workspace)', () => {
    const snapshot = makeSnapshot({
      activeWorktreeId: 'global-floating-terminal',
      pendingReconnectWorktreeIds: ['global-floating-terminal'],
      tabsByWorktree: { 'global-floating-terminal': [{ id: 'tab-1' }] }
    })
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(true)
  })

  it('is true for a mixed restore when the ACTIVE worktree is the local one', () => {
    const snapshot = localRestoreSnapshot()
    snapshot.pendingReconnectWorktreeIds = [SSH_WT, LOCAL_WT]
    snapshot.tabsByWorktree = { ...snapshot.tabsByWorktree, [SSH_WT]: [{ id: 'tab-ssh' }] }
    snapshot.repos = [...snapshot.repos, { id: 'repo-ssh', connectionId: 'ssh-target-1' }]
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(true)
  })

  it('is false for a mixed restore when the ACTIVE worktree is the SSH one — a background local worktree must not hold a worker', () => {
    const snapshot = localRestoreSnapshot()
    snapshot.activeWorktreeId = SSH_WT
    snapshot.pendingReconnectWorktreeIds = [SSH_WT, LOCAL_WT]
    snapshot.tabsByWorktree = { ...snapshot.tabsByWorktree, [SSH_WT]: [{ id: 'tab-ssh' }] }
    snapshot.worktreesByRepo = {
      ...snapshot.worktreesByRepo,
      'repo-ssh': [{ id: SSH_WT, repoId: 'repo-ssh' }]
    }
    snapshot.repos = [...snapshot.repos, { id: 'repo-ssh', connectionId: 'ssh-target-1' }]
    expect(sessionRestoreHasLocalTerminalPanes(snapshot)).toBe(false)
  })
})

describe('warmAtermEngineForSessionRestore', () => {
  beforeEach(() => {
    warmSpy.mockClear()
    resetSessionRestoreWarmForTest()
  })

  it('warms for a local restore', () => {
    warmAtermEngineForSessionRestore(localRestoreSnapshot())
    expect(warmSpy).toHaveBeenCalledTimes(1)
  })

  it('warms at most once per renderer session (remote-workspace re-syncs re-run reconnect)', () => {
    warmAtermEngineForSessionRestore(localRestoreSnapshot())
    warmAtermEngineForSessionRestore(localRestoreSnapshot())
    expect(warmSpy).toHaveBeenCalledTimes(1)
  })

  it('spends its single attempt even when the first invocation does not qualify', () => {
    warmAtermEngineForSessionRestore(makeSnapshot())
    warmAtermEngineForSessionRestore(localRestoreSnapshot())
    expect(warmSpy).not.toHaveBeenCalled()
  })

  it('does not warm for an SSH-only restore', () => {
    warmAtermEngineForSessionRestore(
      makeSnapshot({
        activeWorktreeId: SSH_WT,
        pendingReconnectWorktreeIds: [SSH_WT],
        tabsByWorktree: { [SSH_WT]: [{ id: 'tab-1' }] },
        repos: [{ id: 'repo-ssh', connectionId: 'ssh-target-1' }]
      })
    )
    expect(warmSpy).not.toHaveBeenCalled()
  })
})
