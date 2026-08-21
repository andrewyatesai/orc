// Why: catalog rows (repos, project groups, folder workspaces) arrive over IPC as freshly
// structured-cloned objects every fetch, so reference equality never matches. A structural walk of
// these plain records/arrays is what lets an unchanged refetch reconcile back to the previous
// reference instead of churning identity-keyed selectors.
function isPlainCatalogObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function areCatalogValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => areCatalogValuesEqual(entry, b[index]))
    )
  }
  if (!isPlainCatalogObject(a) || !isPlainCatalogObject(b)) {
    return false
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) {
    return false
  }
  return keys.every((key) => Object.hasOwn(b, key) && areCatalogValuesEqual(a[key], b[key]))
}
