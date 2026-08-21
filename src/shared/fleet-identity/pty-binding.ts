/**
 * PtyBinding — "what is this live process actually using" (§3a of
 * docs/reference/alab-auto-mode-design.md). Consumed by liveness, reattach and
 * audit.
 *
 * Immutable after commit, and `commitPtyBinding` is the only way to make one, so
 * a rotation can never be modelled as editing a live pane's binding in place: a
 * rotation ends one binding and commits another. That is what keeps "what was
 * this pane spending at the time" answerable after the fact.
 *
 * Persisting bindings into the live-PTY registry is R1 (§8.2b) and deliberately
 * belongs in main-owned `PersistedState`, never `GlobalSettings` — routing
 * safety state through the generic renderer settings IPC would expose it.
 *
 * NOT YET WIRED, and that is the intended state — R1 (§8) is the next unbuilt
 * phase, so this identity model is built ahead of the code that will consume it.
 * Nothing outside `src/shared/fleet-identity/` and its own tests imports the
 * directory. Say so here because the Rust port and the green `fleet-identity`
 * parity module make it look integrated from the outside: a cutover attempt
 * would be shimming code the app never calls. Verify with
 * `git grep -l "fleet-identity/" -- src mobile`.
 */

import type { PtyIncarnationId } from '../pty-incarnation'
import { isPtyIncarnationId } from '../pty-incarnation'
import { formatRouteKey, parseRouteKey, routeKeysEqual, type RouteKey } from './route-key'
import {
  createStoreKey,
  formatStoreKey,
  parseStoreKey,
  storeKeysEqual,
  storeKeysOverlap,
  type StoreKey
} from './store-key'

export type PtyBinding = {
  readonly runtimeId: string
  readonly ptyIncarnationId: PtyIncarnationId
  readonly route: RouteKey
  readonly store: StoreKey
}

export type PtyBindingInput = {
  runtimeId: string
  ptyIncarnationId: string
  route: RouteKey
  store: StoreKey
}

/** null when the launch cannot be described — an unattributed pane must stay
 *  unattributed rather than acquire a plausible-looking binding. */
export function commitPtyBinding(input: PtyBindingInput): PtyBinding | null {
  if (!input.runtimeId || !isPtyIncarnationId(input.ptyIncarnationId)) {
    return null
  }
  // Copied, not aliased. `Object.freeze` is shallow, so retaining the caller's
  // `route` object would leave a committed binding mutable through the reference
  // the caller still holds — and "what was this pane spending at the time" is an
  // audit answer that must not be rewritable after the fact.
  return Object.freeze({
    runtimeId: input.runtimeId,
    ptyIncarnationId: input.ptyIncarnationId,
    route: Object.freeze({
      provider: input.route.provider,
      account: Object.freeze({ ...input.route.account }),
      host: Object.freeze({ ...input.route.host })
    }) as RouteKey,
    // createStoreKey already copies and freezes its surface list.
    store: createStoreKey([...input.store.surfaces])
  })
}

export function ptyBindingsEqual(a: PtyBinding, b: PtyBinding): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.ptyIncarnationId === b.ptyIncarnationId &&
    routeKeysEqual(a.route, b.route) &&
    storeKeysEqual(a.store, b.store)
  )
}

export type SerializedPtyBinding = {
  runtimeId: string
  ptyIncarnationId: string
  routeKey: string
  storeKey: string
}

export function serializePtyBinding(binding: PtyBinding): SerializedPtyBinding {
  return {
    runtimeId: binding.runtimeId,
    ptyIncarnationId: binding.ptyIncarnationId,
    routeKey: formatRouteKey(binding.route),
    storeKey: formatStoreKey(binding.store)
  }
}

export function deserializePtyBinding(value: unknown): PtyBinding | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as Partial<SerializedPtyBinding>
  const route = parseRouteKey(raw.routeKey)
  const store = parseStoreKey(raw.storeKey)
  if (!route || !store || typeof raw.runtimeId !== 'string') {
    return null
  }
  return commitPtyBinding({
    runtimeId: raw.runtimeId,
    ptyIncarnationId: String(raw.ptyIncarnationId ?? ''),
    route,
    store
  })
}

/** A live pane blocks a store-scoped drain; an ended incarnation does not. The
 *  caller supplies liveness because only the runtime knows it. */
export function bindingsBlockingStore(
  bindings: readonly PtyBinding[],
  store: StoreKey,
  isLive: (binding: PtyBinding) => boolean
): PtyBinding[] {
  return bindings.filter((binding) => isLive(binding) && storeKeysOverlap(binding.store, store))
}
