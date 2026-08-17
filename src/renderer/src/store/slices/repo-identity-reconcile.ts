import type { Repo } from '../../../../shared/types'
import { getRepoHostIdentity } from './repo-host-identity'
import { areCatalogValuesEqual } from './catalog-value-equality'

// Why: catalog rows (repos, saved runtime environments) arrive over IPC as freshly
// structured-cloned objects — and main's hydration rebuilds nested records — so a reference
// compare reports every row as changed and nothing reconciles. The structural walk compares those
// small sanitized records/arrays by value, letting an unchanged refetch reuse the previous rows
// (and the whole array when nothing moved) so identity-keyed memos and Object.is subscribers stay
// put. `getIdentity` must be the key the producing merge already dedups by, so it is unique
// within `next`.
export function reconcileCatalogRows<T>(
  previous: readonly T[],
  next: readonly T[],
  getIdentity: (row: T) => string
): T[] {
  const previousByIdentity = new Map(previous.map((row) => [getIdentity(row), row]))
  let identical = next.length === previous.length
  const reconciled = next.map((row, index) => {
    const existing = previousByIdentity.get(getIdentity(row))
    if (existing !== undefined && areCatalogValuesEqual(existing, row)) {
      if (existing !== previous[index]) {
        identical = false
      }
      return existing
    }
    identical = false
    return row
  })
  return identical ? (previous as T[]) : reconciled
}

// Why: after a drag-reorder we optimistically set `repos`, persist, and main
// broadcasts `repos:changed`. The renderer's own echo handler refetches, which
// would otherwise hand back field-identical repos as brand-new objects. New
// identities invalidate the repoMap/repoOrder/rows memos and force the
// virtualizer to rebuild + re-measure a tick after the drop — the visible jump.
export function reconcileFetchedRepos(previous: readonly Repo[], next: readonly Repo[]): Repo[] {
  return reconcileCatalogRows(previous, next, getRepoHostIdentity)
}
