import { areCatalogValuesEqual } from './catalog-value-equality'

// Why: catalog fetches rebuild every row from IPC, so identity alone never matches. Reconciling the
// freshly-built array against the previous store array reuses each unchanged element ref (and hands
// back the whole previous array when nothing moved), keeping referential-equality selectors quiet so
// a `repos:changed` echo doesn't re-force the folder path-status sweep for every row.
export function reconcileCatalogArrayIdentity<T>(
  previous: readonly T[],
  next: readonly T[],
  getIdentity: (entry: T) => string
): T[] {
  const previousByIdentity = new Map(previous.map((entry) => [getIdentity(entry), entry]))
  let identical = next.length === previous.length
  const reconciled = next.map((entry, index) => {
    const existing = previousByIdentity.get(getIdentity(entry))
    if (existing && areCatalogValuesEqual(existing, entry)) {
      if (existing !== previous[index]) {
        identical = false
      }
      return existing
    }
    identical = false
    return entry
  })
  return identical ? (previous as T[]) : reconciled
}

// Why: the sidebar effect watching these catalog arrays is the only thing that refills the folder
// path-status cache, so a no-op refetch must not wipe it — nothing else would repopulate it. A
// row-wise reference compare is the same signal that effect fires on.
export function catalogRowsUnchanged<T>(next: readonly T[], previous: readonly T[]): boolean {
  return (
    next === previous ||
    (next.length === previous.length && next.every((row, index) => row === previous[index]))
  )
}
