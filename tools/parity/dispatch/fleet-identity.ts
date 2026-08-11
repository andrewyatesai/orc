// TS dispatch for the fleet-identity parity module: drives the LIVE
// src/shared/fleet-identity/{route-key,store-key,pty-binding}.ts against the
// Rust port (orca-policy::fleet_identity).
//
// These keys are authority, not labels: a route key names whose subscription is
// spent, a store key names which credential surfaces a launch may mutate, and a
// binding is the audit answer to "what was this pane spending at the time". A
// divergence here is a credential-corruption bug, so both sides run one corpus.
//
// Three invariants the vectors pin explicitly, because each is easy to port into
// something that looks right and is not:
//   1. storeKeysOverlap is OVERLAP, not equality (partial overlap is a collision);
//   2. parseRouteKey requires a CANONICAL ROUND-TRIP (two spellings, one route);
//   3. unionStoreKeys locks every store a rotation touches, not one directory.
//
// Bindings cross the seam in their PERSISTED form (serializePtyBinding), which
// is the only form both sides can name — the committed object itself is frozen
// and identity-bearing on the TS side.

import {
  formatRouteAccountScope,
  formatRouteKey,
  parseRouteKey,
  routeKeysEqual,
  type RouteKey
} from '../../../src/shared/fleet-identity/route-key'
import {
  createStoreKey,
  formatStoreKey,
  parseStoreKey,
  storeKeysEqual,
  storeKeysOverlap,
  unionStoreKeys,
  type CredentialSurface,
  type StoreKey
} from '../../../src/shared/fleet-identity/store-key'
import {
  bindingsBlockingStore,
  commitPtyBinding,
  deserializePtyBinding,
  ptyBindingsEqual,
  serializePtyBinding,
  type PtyBinding
} from '../../../src/shared/fleet-identity/pty-binding'
import type { TuiAgent } from '../../../src/shared/types'

type RouteVector = {
  provider?: string
  account?: { kind?: string; accountId?: string }
  host?: { kind?: string; distro?: string | null; targetId?: string; environmentId?: string }
}

type StoreVector = { surfaces?: CredentialSurface[] }

type BindingVector = {
  runtimeId?: string
  ptyIncarnationId?: string
  route?: RouteVector
  store?: StoreVector
  /** Liveness is the runtime's answer, not the module's — the vector supplies it. */
  live?: boolean
}

/** An absent `distro` reads as null: "the default distro", same as the Rust side. */
function toRouteKey(raw: RouteVector | undefined): RouteKey {
  const account = raw?.account
  const host = raw?.host
  return {
    provider: (raw?.provider ?? '') as TuiAgent,
    account:
      account?.kind === 'managed'
        ? { kind: 'managed', accountId: account.accountId ?? '' }
        : { kind: 'system-default' },
    host:
      host?.kind === 'wsl'
        ? { kind: 'wsl', distro: host.distro ?? null }
        : host?.kind === 'ssh'
          ? { kind: 'ssh', targetId: host.targetId ?? '' }
          : host?.kind === 'runtime'
            ? { kind: 'runtime', environmentId: host.environmentId ?? '' }
            : { kind: 'local' }
  }
}

function toStoreKey(raw: StoreVector | undefined): StoreKey {
  return createStoreKey(raw?.surfaces ?? [])
}

function toBinding(raw: BindingVector | undefined): PtyBinding | null {
  return commitPtyBinding({
    runtimeId: raw?.runtimeId ?? '',
    ptyIncarnationId: raw?.ptyIncarnationId ?? '',
    route: toRouteKey(raw?.route),
    store: toStoreKey(raw?.store)
  })
}

function persisted(binding: PtyBinding | null): unknown {
  return binding === null ? null : serializePtyBinding(binding)
}

export function dispatch(fn: string, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>
  switch (fn) {
    case 'formatRouteKey':
      return formatRouteKey(toRouteKey(args.route as RouteVector))
    case 'parseRouteKey':
      // Passed through unchanged, including non-strings: rejecting a value that
      // is not a route key is the decision under test.
      return parseRouteKey(args.value)
    case 'routeKeysEqual':
      return routeKeysEqual(toRouteKey(args.a as RouteVector), toRouteKey(args.b as RouteVector))
    case 'formatRouteAccountScope':
      return formatRouteAccountScope(toRouteKey(args.route as RouteVector))
    case 'createStoreKey':
      return toStoreKey(args as StoreVector)
    case 'formatStoreKey':
      return formatStoreKey(toStoreKey(args as StoreVector))
    case 'parseStoreKey':
      return parseStoreKey(args.value)
    case 'storeKeysEqual':
      return storeKeysEqual(toStoreKey(args.a as StoreVector), toStoreKey(args.b as StoreVector))
    case 'storeKeysOverlap':
      return storeKeysOverlap(toStoreKey(args.a as StoreVector), toStoreKey(args.b as StoreVector))
    case 'unionStoreKeys':
      return unionStoreKeys(((args.keys ?? []) as StoreVector[]).map(toStoreKey))
    case 'commitPtyBinding':
      return persisted(toBinding(args as BindingVector))
    case 'ptyBindingsEqual': {
      const a = toBinding(args.a as BindingVector)
      const b = toBinding(args.b as BindingVector)
      if (!a || !b) {
        return { __parity_error__: 'ptyBindingsEqual: a vector binding did not commit' }
      }
      return ptyBindingsEqual(a, b)
    }
    case 'deserializePtyBinding':
      return persisted(deserializePtyBinding(args.value))
    case 'bindingsBlockingStore': {
      const rows = (args.bindings ?? []) as BindingVector[]
      const bindings = rows.map(toBinding)
      if (bindings.some((binding) => binding === null)) {
        return { __parity_error__: 'bindingsBlockingStore: a vector binding did not commit' }
      }
      const committed = bindings as PtyBinding[]
      // Keyed by object identity — the same liveness oracle the Rust adapter
      // rebuilds from (runtimeId, incarnation), written independently on purpose.
      const live = new Map(committed.map((binding, index) => [binding, rows[index]?.live === true]))
      return bindingsBlockingStore(
        committed,
        toStoreKey(args.store as StoreVector),
        (binding) => live.get(binding) === true
      ).map((binding) => serializePtyBinding(binding))
    }
    default:
      return { __parity_error__: `unknown function ${fn}` }
  }
}
