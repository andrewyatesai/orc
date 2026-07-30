import { describe, expect, it } from 'vitest'
import {
  resolveRestoreScrollbackPrefetchRefs,
  TERMINAL_SCROLLBACK_PREFETCH_MAX_REFS,
  type RestoreScrollbackPrefetchSession
} from './terminal-scrollback-restore-prefetch'

function layout(
  activeLeafId: string | null,
  refsByLeafId: Record<string, string>
): RestoreScrollbackPrefetchSession['terminalLayoutsByTabId'][string] {
  return {
    root: activeLeafId ? { type: 'leaf', leafId: activeLeafId } : null,
    activeLeafId,
    expandedLeafId: null,
    scrollbackRefsByLeafId: refsByLeafId
  }
}

describe('resolveRestoreScrollbackPrefetchRefs', () => {
  it('reads the focused pane of the active tab first', () => {
    const refs = resolveRestoreScrollbackPrefetchRefs({
      activeWorkspaceKey: 'worktree:wt-1',
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-other',
      activeTabIdByWorktree: { 'worktree:wt-1': 'tab-1' },
      terminalLayoutsByTabId: {
        'tab-1': layout('leaf-b', { 'leaf-a': 'v1-a', 'leaf-b': 'v1-b' }),
        'tab-other': layout('leaf-c', { 'leaf-c': 'v1-c' })
      }
    })

    expect(refs).toEqual(['v1-b', 'v1-a', 'v1-c'])
  })

  it('covers every split group that mounts alongside the focused tab', () => {
    const refs = resolveRestoreScrollbackPrefetchRefs({
      activeWorkspaceKey: null,
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-1',
      tabGroups: {
        'wt-1': [
          { id: 'g1', worktreeId: 'wt-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] },
          { id: 'g2', worktreeId: 'wt-1', activeTabId: 'tab-2', tabOrder: ['tab-2'] }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': layout('leaf-a', { 'leaf-a': 'v1-a' }),
        'tab-2': layout('leaf-b', { 'leaf-b': 'v1-b' }),
        'tab-background': layout('leaf-z', { 'leaf-z': 'v1-z' })
      }
    })

    // Background tabs mount on a later tab switch, not during restore.
    expect(refs).toEqual(['v1-a', 'v1-b'])
  })

  it('resolves folder workspaces and legacy raw-worktree keys alike', () => {
    const folder = resolveRestoreScrollbackPrefetchRefs({
      activeWorkspaceKey: 'folder:f-1',
      activeWorktreeId: null,
      activeTabId: null,
      activeTabIdByWorktree: { 'folder:f-1': 'tab-1' },
      terminalLayoutsByTabId: { 'tab-1': layout('leaf-a', { 'leaf-a': 'v1-a' }) }
    })
    expect(folder).toEqual(['v1-a'])

    const legacy = resolveRestoreScrollbackPrefetchRefs({
      activeWorkspaceKey: 'worktree:wt-1',
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      activeTabIdByWorktree: { 'wt-1': 'tab-1' },
      terminalLayoutsByTabId: { 'tab-1': layout('leaf-a', { 'leaf-a': 'v1-a' }) }
    })
    expect(legacy).toEqual(['v1-a'])
  })

  it('caps the budget and never repeats a ref', () => {
    const refsByLeafId = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`leaf-${index}`, `v1-${index}`])
    )
    const session: RestoreScrollbackPrefetchSession = {
      activeWorkspaceKey: null,
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { 'wt-1': 'tab-1' },
      terminalLayoutsByTabId: { 'tab-1': layout('leaf-0', refsByLeafId) }
    }

    const refs = resolveRestoreScrollbackPrefetchRefs(session)
    expect(refs).toHaveLength(TERMINAL_SCROLLBACK_PREFETCH_MAX_REFS)
    expect(new Set(refs).size).toBe(refs.length)
    expect(resolveRestoreScrollbackPrefetchRefs(session, 0)).toEqual([])
  })

  it('returns nothing for sessions with no restorable scrollback', () => {
    expect(
      resolveRestoreScrollbackPrefetchRefs({
        activeWorkspaceKey: null,
        activeWorktreeId: null,
        activeTabId: 'tab-missing',
        terminalLayoutsByTabId: { 'tab-1': layout('leaf-a', {}) }
      })
    ).toEqual([])
  })
})
