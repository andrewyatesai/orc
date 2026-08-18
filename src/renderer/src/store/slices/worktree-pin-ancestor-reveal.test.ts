import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { hasChangedLineageAncestor } from './worktree-pin-ancestor-reveal'

const baseWorktree: Worktree = {
  id: 'wt-base',
  repoId: 'repo-1',
  path: '/tmp/orca-base',
  branch: 'refs/heads/base',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'base',
  sortOrder: 0,
  lastActivityAt: 0
}

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return { ...baseWorktree, id, instanceId: `${id}-instance`, displayName: id, ...overrides }
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'cli',
    capture: { source: 'terminal-context', confidence: 'inferred' },
    createdAt: 1
  }
}

function resolver(worktrees: Worktree[]): (id: string) => Worktree | undefined {
  const byId = new Map(worktrees.map((wt) => [wt.id, wt]))
  return (id) => byId.get(id)
}

describe('hasChangedLineageAncestor', () => {
  const parent = makeWorktree('parent')
  const child = makeWorktree('child')
  const grandchild = makeWorktree('grandchild')

  it('reveals a focused descendant when its ancestor pin changed', () => {
    expect(
      hasChangedLineageAncestor({
        worktreeId: grandchild.id,
        changedWorktreeIds: new Set([parent.id]),
        lineageById: {
          [child.id]: makeLineage(child, parent),
          [grandchild.id]: makeLineage(grandchild, child)
        },
        getKnownWorktreeById: resolver([parent, child, grandchild])
      })
    ).toBe(true)
  })

  it('follows embedded legacy lineage when the projection map is empty', () => {
    const embeddedChild = { ...child, lineage: makeLineage(child, parent) }
    expect(
      hasChangedLineageAncestor({
        worktreeId: embeddedChild.id,
        changedWorktreeIds: new Set([parent.id]),
        lineageById: {},
        getKnownWorktreeById: resolver([parent, embeddedChild])
      })
    ).toBe(true)
  })

  it('ignores an unrelated changed worktree', () => {
    expect(
      hasChangedLineageAncestor({
        worktreeId: child.id,
        changedWorktreeIds: new Set([makeWorktree('other').id]),
        lineageById: { [child.id]: makeLineage(child, parent) },
        getKnownWorktreeById: resolver([parent, child])
      })
    ).toBe(false)
  })

  it('does not walk through cyclic lineage rejected by rendering', () => {
    const first = makeWorktree('first')
    const second = makeWorktree('second')
    expect(
      hasChangedLineageAncestor({
        worktreeId: second.id,
        changedWorktreeIds: new Set([first.id]),
        lineageById: {
          [first.id]: makeLineage(first, second),
          [second.id]: makeLineage(second, first)
        },
        getKnownWorktreeById: resolver([first, second])
      })
    ).toBe(false)
  })

  it('does not reveal through a stale lineage edge whose parent instance was replaced', () => {
    const replacedParent = makeWorktree('parent', { instanceId: 'replacement-parent-instance' })
    expect(
      hasChangedLineageAncestor({
        worktreeId: child.id,
        changedWorktreeIds: new Set([replacedParent.id]),
        lineageById: { [child.id]: makeLineage(child, parent) },
        getKnownWorktreeById: resolver([replacedParent, child])
      })
    ).toBe(false)
  })
})
