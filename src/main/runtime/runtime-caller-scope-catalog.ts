// Why: asserting the caller bound inside each resolver makes safety a list that
// has to stay complete — one resolver nobody remembered is an open door, and the
// door is invisible because the resolver looks like every other resolver. These
// bound the CATALOGS instead: the maps and lists resolvers read. An object the
// caller may not reach is simply not in what a resolver sees, so a resolver that
// forgets to check cannot reach one. A local caller is the default and gets the
// input back by reference — no copy, no ownership lookups, no behavior change.
import {
  assertCallerScopeReaches,
  callerScopeReaches,
  getCallerScope,
  type CallerScopeObjectOwner
} from './runtime-caller-scope'

export function filterToCallerScope<T>(
  items: T[],
  ownerOf: (item: T) => CallerScopeObjectOwner
): T[] {
  const scope = getCallerScope()
  if (scope.kind === 'local') {
    return items
  }
  return items.filter((item) => callerScopeReaches(scope, ownerOf(item)))
}

/**
 * For records that span hosts — a project has one checkout per host — visibility
 * is "reaches any of them", never "reaches the first one listed".
 */
export function filterToCallerScopeByAnyOwner<T>(
  items: T[],
  ownersOf: (item: T) => Iterable<CallerScopeObjectOwner>
): T[] {
  const scope = getCallerScope()
  if (scope.kind === 'local') {
    return items
  }
  return items.filter((item) => {
    for (const owner of ownersOf(item)) {
      if (callerScopeReaches(scope, owner)) {
        return true
      }
    }
    return false
  })
}

/**
 * A registry keyed by a caller-supplied identifier (terminal handle, pane key).
 * `get` is the bounded read and is deliberately the shortest name: code that
 * must see every entry regardless of who asked has to say `getUnscoped`, so the
 * unsafe read never happens by omission.
 *
 * A key naming an out-of-scope entry is refused rather than reported missing —
 * "not found" reads as a typo and hides the boundary that stopped the call.
 */
export class CallerScopedRegistry<V> {
  private entries = new Map<string, V>()

  constructor(
    private readonly ownerOf: (value: V) => CallerScopeObjectOwner,
    private readonly describe: (key: string, value: V) => string
  ) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) {
      return undefined
    }
    const scope = getCallerScope()
    if (scope.kind === 'local') {
      return value
    }
    assertCallerScopeReaches(scope, this.ownerOf(value), this.describe(key, value))
    return value
  }

  /** Host bookkeeping is not a caller: pruning, reindexing and handle minting see everything. */
  getUnscoped(key: string): V | undefined {
    return this.entries.get(key)
  }

  /** Iteration a caller sees: out-of-scope entries are absent rather than refused. */
  valuesForCaller(): Iterable<V> {
    const scope = getCallerScope()
    if (scope.kind === 'local') {
      return this.entries.values()
    }
    return [...this.entries.values()].filter((value) =>
      callerScopeReaches(scope, this.ownerOf(value))
    )
  }

  set(key: string, value: V): this {
    this.entries.set(key, value)
    return this
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  values(): IterableIterator<V> {
    return this.entries.values()
  }

  /**
   * Wholesale swap for graph rebuilds, which republish the registry from
   * scratch. Takes ownership of `next` and hands back the map it displaced, so
   * a rebuild that needs the "before" view gets it without copying: this runs on
   * every renderer graph sync, once per open pane.
   */
  replaceAll(next: Map<string, V>): ReadonlyMap<string, V> {
    const previous = this.entries
    this.entries = next
    return previous
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries[Symbol.iterator]()
  }
}
