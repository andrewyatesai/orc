import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'
import { getPinnedSectionWorktrees, isPinnedSectionWorktree } from './pinned-section-worktrees'

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
  return {
    ...baseWorktree,
    id,
    instanceId: `${id}-instance`,
    displayName: id,
    ...overrides
  }
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

describe('getPinnedSectionWorktrees', () => {
  const parent = makeWorktree('parent')
  const child = makeWorktree('child')
  const grandchild = makeWorktree('grandchild')
  const sibling = makeWorktree('sibling')
  const lineageById = {
    [child.id]: makeLineage(child, parent),
    [grandchild.id]: makeLineage(grandchild, child)
  }
  const worktreeMap = new Map([
    [parent.id, parent],
    [child.id, child],
    [grandchild.id, grandchild],
    [sibling.id, sibling]
  ])

  it('includes only explicitly pinned rows when there is no lineage', () => {
    const pinned = makeWorktree('pinned', { isPinned: true })
    const loose = makeWorktree('loose')

    expect(getPinnedSectionWorktrees([pinned, loose], {}, new Map([[pinned.id, pinned]]))).toEqual([
      pinned
    ])
  })

  it('includes visible descendants of a pinned parent', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedParent.id, pinnedParent)

    expect(
      getPinnedSectionWorktrees([pinnedParent, child, grandchild, sibling], lineageById, map).map(
        (worktree) => worktree.id
      )
    ).toEqual([pinnedParent.id, child.id, grandchild.id])
  })

  it("does not pull a pinned child's unpinned parent into Pinned", () => {
    const pinnedChild = { ...child, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedChild.id, pinnedChild)

    expect(
      getPinnedSectionWorktrees([parent, pinnedChild], lineageById, map).map(
        (worktree) => worktree.id
      )
    ).toEqual([pinnedChild.id])
  })

  it('keeps a visible grandchild when the middle parent is absent from the visible list', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedParent.id, pinnedParent)

    expect(
      getPinnedSectionWorktrees([pinnedParent, grandchild], lineageById, map).map(
        (worktree) => worktree.id
      )
    ).toEqual([pinnedParent.id, grandchild.id])
  })

  it('does not collect descendants of a pinned parent that is not itself visible', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const map = new Map(worktreeMap)
    map.set(pinnedParent.id, pinnedParent)

    expect(
      getPinnedSectionWorktrees([child, sibling], lineageById, map).map((worktree) => worktree.id)
    ).toEqual([])
  })

  it('handles a deep pinned lineage without overflowing the renderer stack', () => {
    const depth = 6_000
    const worktrees: Worktree[] = []
    const deepLineageById: Record<string, WorktreeLineage> = {}
    for (let index = 0; index < depth; index++) {
      const current = makeWorktree(`deep-${index}`, { isPinned: index === 0 })
      worktrees.push(current)
      const priorParent = worktrees[index - 1]
      if (priorParent) {
        deepLineageById[current.id] = makeLineage(current, priorParent)
      }
    }

    expect(
      getPinnedSectionWorktrees(
        worktrees,
        deepLineageById,
        new Map(worktrees.map((worktree) => [worktree.id, worktree]))
      )
    ).toHaveLength(depth)
  })
})

describe('isPinnedSectionWorktree', () => {
  const parent = makeWorktree('parent', { isPinned: true })
  const child = makeWorktree('child')
  const lineageById = { [child.id]: makeLineage(child, parent) }
  const worktreeMap = new Map([
    [parent.id, parent],
    [child.id, child]
  ])

  it('treats an unpinned child of a visible pinned parent as pinned-section membership', () => {
    expect(isPinnedSectionWorktree(child, [parent, child], lineageById, worktreeMap)).toBe(true)
  })

  it('does not treat an unrelated unpinned workspace as pinned-section membership', () => {
    const other = makeWorktree('other')
    expect(isPinnedSectionWorktree(other, [parent, child, other], lineageById, worktreeMap)).toBe(
      false
    )
  })
})
