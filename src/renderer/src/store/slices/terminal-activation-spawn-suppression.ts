import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'

function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}

// Why: a split tab remounts several panes per retry; count them so each activation callback is
// suppressed without hiding later real activity. Mirrors worktrees.ts getActivationSpawnSuppression
// (kept separate to avoid churning that file for a shared 7-line pure helper).
export function getTerminalActivationSpawnSuppression(
  layout: TerminalLayoutSnapshot | undefined
): true | number {
  const paneCount = Math.max(
    1,
    countTerminalLayoutLeaves(layout?.root),
    Object.keys(layout?.ptyIdsByLeafId ?? {}).length
  )
  return paneCount === 1 ? true : paneCount
}
