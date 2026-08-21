import {
  getCyclicWorktreeLineageChildIds,
  isValidResolvedWorktreeLineageEdge
} from '../../../../shared/resolved-worktree-lineage'
import type { Worktree, WorktreeLineage } from '../../../../shared/types'

type WorktreeWithEmbeddedLineage = Worktree & { lineage?: WorktreeLineage | null }

function getProjectedLineage(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktree: Worktree
): WorktreeLineage | null {
  if (Object.hasOwn(lineageById, worktree.id)) {
    return lineageById[worktree.id] ?? null
  }
  return (worktree as WorktreeWithEmbeddedLineage).lineage ?? null
}

// Why: a pin toggle on an unfocused ancestor still moves the focused descendant
// between Pinned and its natural group, so we reveal it to keep focus in view.
// Mirrors the renderer's Pinned-section membership: walk the same validated,
// cycle-pruned lineage the sidebar renders and stop where rendering would.
export function hasChangedLineageAncestor(args: {
  worktreeId: string
  changedWorktreeIds: ReadonlySet<string>
  lineageById: Readonly<Record<string, WorktreeLineage>>
  getKnownWorktreeById: (id: string) => Worktree | undefined
}): boolean {
  const { worktreeId, changedWorktreeIds, lineageById, getKnownWorktreeById } = args
  const seen = new Set<string>()
  const validLineageByChildId = new Map<string, WorktreeLineage>()
  let child = getKnownWorktreeById(worktreeId)
  while (child && !seen.has(child.id)) {
    seen.add(child.id)
    const lineage = getProjectedLineage(lineageById, child)
    const parent = lineage ? getKnownWorktreeById(lineage.parentWorktreeId) : undefined
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      break
    }
    validLineageByChildId.set(child.id, lineage)
    child = parent
  }
  const cyclicIds = getCyclicWorktreeLineageChildIds(validLineageByChildId)
  child = getKnownWorktreeById(worktreeId)
  while (child && !cyclicIds.has(child.id)) {
    const lineage = getProjectedLineage(lineageById, child)
    const parent = lineage ? getKnownWorktreeById(lineage.parentWorktreeId) : undefined
    if (!lineage || !parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      return false
    }
    if (changedWorktreeIds.has(parent.id)) {
      return true
    }
    child = parent
  }
  return false
}
