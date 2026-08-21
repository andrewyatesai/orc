/**
 * StoreKey — "can two live CLIs coexist here" (§3a of
 * docs/reference/alab-auto-mode-design.md). Consumed by drain, mutex and
 * materialization.
 *
 * It is a SET of mutable credential surfaces, not a directory path, because the
 * v3 reviewers' root finding was that a launch mutates several surfaces at once:
 * config dir, auth file, and on darwin BOTH the scoped and the legacy keychain
 * item. A key that named only the config dir would report two launches as
 * disjoint while they fight over one keychain entry.
 *
 * Kept independent of RouteKey on purpose: §3a rule 1 — health may be
 * account-scoped, but credential mutation must be store-scoped, and an
 * account-keyed drain cannot answer whether a physical store is unused.
 *
 * NOT YET WIRED, and that is the intended state — R1 (§8) is the next unbuilt
 * phase, so this identity model is built ahead of the code that will consume it.
 * Nothing outside `src/shared/fleet-identity/` and its own tests imports the
 * directory. Say so here because the Rust port and the green `fleet-identity`
 * parity module make it look integrated from the outside: a cutover attempt
 * would be shimming code the app never calls. Verify with
 * `git grep -l "fleet-identity/" -- src mobile`.
 */

export type CredentialSurface =
  | { kind: 'config-dir'; path: string }
  | { kind: 'auth-file'; path: string }
  | { kind: 'keychain-item'; service: string; account: string }

/** Opaque by construction — build with `createStoreKey` so the contents are
 *  always normalized, deduped and ordered. */
export type StoreKey = {
  readonly surfaces: readonly CredentialSurface[]
}

/**
 * Trailing separators are stripped so `/home/u/.claude` and `/home/u/.claude/`
 * are one surface. They name the same directory, and treating them as disjoint
 * would let a store-scoped drain proceed while a live CLI still holds the store
 * — the exact failure this type exists to prevent.
 *
 * Case is deliberately NOT normalized: darwin and Windows are usually
 * case-insensitive and Linux is not, so folding case would merge two genuinely
 * distinct stores on Linux. Over-merging is the more dangerous direction here,
 * because it would report a collision that does not exist and stall a rotation.
 */
function normalizeSurfacePath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  // A bare root ("/" or "C:\") normalizes to empty; keep the original.
  return trimmed.length > 0 ? trimmed : path
}

function formatSurface(surface: CredentialSurface): string {
  switch (surface.kind) {
    case 'config-dir':
      return `config-dir:${encodeURIComponent(normalizeSurfacePath(surface.path))}`
    case 'auth-file':
      return `auth-file:${encodeURIComponent(normalizeSurfacePath(surface.path))}`
    case 'keychain-item':
      return `keychain-item:${encodeURIComponent(surface.service)}:${encodeURIComponent(surface.account)}`
  }
}

function parseSurface(value: string): CredentialSurface | null {
  const [kind, ...rest] = value.split(':')
  if (kind === 'config-dir' && rest.length === 1) {
    return { kind, path: decodeURIComponent(rest[0]) }
  }
  if (kind === 'auth-file' && rest.length === 1) {
    return { kind, path: decodeURIComponent(rest[0]) }
  }
  if (kind === 'keychain-item' && rest.length === 2) {
    return { kind, service: decodeURIComponent(rest[0]), account: decodeURIComponent(rest[1]) }
  }
  return null
}

/** Sorted + deduped so two launches naming the same surfaces in a different
 *  order produce one key, and `formatStoreKey` is a usable SQLite column value. */
export function createStoreKey(surfaces: readonly CredentialSurface[]): StoreKey {
  const byFormat = new Map<string, CredentialSurface>()
  for (const surface of surfaces) {
    // Stored normalized AND copied: the retained surface must agree with the
    // formatted key, and must not alias an object the caller can still mutate.
    const normalized: CredentialSurface =
      surface.kind === 'keychain-item'
        ? { ...surface }
        : { kind: surface.kind, path: normalizeSurfacePath(surface.path) }
    byFormat.set(formatSurface(normalized), normalized)
  }
  const ordered = [...byFormat.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, surface]) => surface)
  return { surfaces: Object.freeze(ordered) }
}

export function formatStoreKey(key: StoreKey): string {
  return key.surfaces.map(formatSurface).join('|')
}

export function parseStoreKey(value: unknown): StoreKey | null {
  if (typeof value !== 'string') {
    return null
  }
  if (value.length === 0) {
    return createStoreKey([])
  }
  const surfaces: CredentialSurface[] = []
  for (const part of value.split('|')) {
    let surface: CredentialSurface | null
    try {
      surface = parseSurface(part)
    } catch {
      // decodeURIComponent throws on a malformed escape; a store key read back
      // from SQLite or a CLI flag is untrusted, so reject rather than throw.
      return null
    }
    if (!surface) {
      return null
    }
    surfaces.push(surface)
  }
  return createStoreKey(surfaces)
}

export function storeKeysEqual(a: StoreKey, b: StoreKey): boolean {
  return formatStoreKey(a) === formatStoreKey(b)
}

/**
 * The load-bearing predicate: two launches may run concurrently only when they
 * share NO surface. Equality is the wrong test — a partial overlap (same
 * keychain item, different config dir) is still a collision, and treating it as
 * disjoint is exactly how two live CLIs corrupt one credential.
 */
export function storeKeysOverlap(a: StoreKey, b: StoreKey): boolean {
  const seen = new Set(a.surfaces.map(formatSurface))
  return b.surfaces.some((surface) => seen.has(formatSurface(surface)))
}

/** A rotation is a multi-key transaction (§3a rule 2), so the saga must lock the
 *  union of every store it touches — never one directory mutex. */
export function unionStoreKeys(keys: readonly StoreKey[]): StoreKey {
  return createStoreKey(keys.flatMap((key) => [...key.surfaces]))
}
