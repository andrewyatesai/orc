// Catalog rows (`createdAt`/`updatedAt`) are seeded from `repo.addedAt`, which is 0 / absent / NaN
// for repos that predate timestamped rows. These helpers keep that "unknown" out of the arithmetic.

// Why: `addedAt || now` restamps Date.now() when addedAt is 0 / absent / NaN, so every
// projection looks dirty and reconcileCatalogRows never reuses the project or setup.
export function catalogTimestampFromAddedAt(addedAt: number): number {
  return Number.isFinite(addedAt) ? addedAt : 0
}

// Why: 0 / absent / NaN means "the repo predates timestamped catalog rows", not epoch. Keeping
// it out of min()/max() stops one unknown sibling from wiping a real timestamp — and unlike the
// old `|| now` fallback it stays order-independent, so both merge orders agree.
function knownCatalogTimestamp(value: number): number | undefined {
  return Number.isFinite(value) && value !== 0 ? value : undefined
}

/** Oldest of two catalog `createdAt` values, treating 0/NaN on either side as unknown. */
export function mergeCatalogCreatedAt(left: number, right: number): number {
  const known = knownCatalogTimestamp(left)
  const other = knownCatalogTimestamp(right)
  if (known === undefined || other === undefined) {
    return known ?? other ?? 0
  }
  return Math.min(known, other)
}

/** Newest of two catalog `updatedAt` values, treating 0/NaN on either side as unknown. */
export function mergeCatalogUpdatedAt(left: number, right: number): number {
  const known = knownCatalogTimestamp(left)
  const other = knownCatalogTimestamp(right)
  if (known === undefined || other === undefined) {
    return known ?? other ?? 0
  }
  return Math.max(known, other)
}
