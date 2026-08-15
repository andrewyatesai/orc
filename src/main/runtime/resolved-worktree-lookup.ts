import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { splitWorktreeId } from '../../shared/worktree-id'

// Domain-tagged identity key: parsed ids collapse to (repoId, normalized path) so
// path spelling matches across hosts; unparseable ids stay in a separate `raw`
// domain so they never collide with a parsed identity that shares the same text.
export function runtimeWorktreeLookupKey(worktreeId: string): string {
  const parsed = splitWorktreeId(worktreeId)
  return JSON.stringify(
    parsed
      ? ['parsed', parsed.repoId, normalizeRuntimePathForComparison(parsed.worktreePath)]
      : ['raw', worktreeId]
  )
}

// Index resolvedWorktrees lazily by identity so repeated per-PTY owner lookups cost
// one linear pass total instead of an Array.find scan each. Indexing halts at the
// first match, and preserves Array.find's first-match on identity collisions.
export function createIncrementalResolvedWorktreeLookup<T extends { id: string }>(
  resolvedWorktrees: readonly T[]
): (worktreeId: string) => T | undefined {
  const worktreeByIdentity = new Map<string, T>()
  let indexedCount = 0
  return (worktreeId) => {
    const lookupKey = runtimeWorktreeLookupKey(worktreeId)
    const indexed = worktreeByIdentity.get(lookupKey)
    if (indexed) {
      return indexed
    }
    while (indexedCount < resolvedWorktrees.length) {
      const worktree = resolvedWorktrees[indexedCount]
      indexedCount += 1
      const key = runtimeWorktreeLookupKey(worktree.id)
      if (!worktreeByIdentity.has(key)) {
        worktreeByIdentity.set(key, worktree)
      }
      if (key === lookupKey) {
        return worktreeByIdentity.get(key)
      }
    }
    return undefined
  }
}
