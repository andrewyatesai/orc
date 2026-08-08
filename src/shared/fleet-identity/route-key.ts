/**
 * RouteKey — "which subscription am I spending, on which host" (§3a of
 * docs/reference/alab-auto-mode-design.md). Consumed by chains, health, probes
 * and reservations.
 *
 * The tagged account is the point: `system-default` is a real, spendable route
 * and is NOT representable in an accountId-keyed map, which is why v3's
 * `sessionId -> accountId` map and `(provider, accountId)` queue were both
 * under-keyed. Never model this as `accountId: string | null`.
 */

import type { TuiAgent } from '../types'

export type RouteAccount =
  | { kind: 'system-default' }
  | { kind: 'managed'; accountId: string }

/**
 * §3a names `local | wsl:<distro> | ssh:<host>`. `runtime` is added here because
 * remote-runtime panes are a real execution host the design handles elsewhere
 * (§5.5, §10) and a host type that cannot name them would force callers to lie.
 * `wsl` carries a null distro for "the default distro", matching
 * `getWslSelectionKey`'s normalization rather than inventing a second spelling.
 */
export type RouteHost =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string | null }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'runtime'; environmentId: string }

export type RouteKey = {
  provider: TuiAgent
  account: RouteAccount
  host: RouteHost
}

const SYSTEM_DEFAULT = 'system-default'

function normalizeDistro(distro: string | null | undefined): string | null {
  const trimmed = distro?.trim()
  return trimmed ? trimmed : null
}

function formatAccount(account: RouteAccount): string {
  return account.kind === 'managed'
    ? `managed:${encodeURIComponent(account.accountId)}`
    : SYSTEM_DEFAULT
}

function formatHost(host: RouteHost): string {
  switch (host.kind) {
    case 'local':
      return 'local'
    case 'wsl': {
      const distro = normalizeDistro(host.distro)
      return distro ? `wsl:${encodeURIComponent(distro)}` : 'wsl'
    }
    case 'ssh':
      return `ssh:${encodeURIComponent(host.targetId)}`
    case 'runtime':
      return `runtime:${encodeURIComponent(host.environmentId)}`
  }
}

/**
 * Stable string form, safe as a SQLite key (`rotation_sagas.target_route_key`).
 * Every variable part is percent-encoded, so the only unescaped `/`, `@` and `:`
 * are this grammar's own separators and parsing is unambiguous.
 */
export function formatRouteKey(key: RouteKey): string {
  return `${encodeURIComponent(key.provider)}/${formatAccount(key.account)}@${formatHost(key.host)}`
}

function parseAccount(value: string): RouteAccount | null {
  if (value === SYSTEM_DEFAULT) {
    return { kind: 'system-default' }
  }
  const managed = value.startsWith('managed:') ? value.slice('managed:'.length) : null
  if (managed === null || managed.length === 0) {
    return null
  }
  return { kind: 'managed', accountId: decodeURIComponent(managed) }
}

function parseHost(value: string): RouteHost | null {
  if (value === 'local') {
    return { kind: 'local' }
  }
  if (value === 'wsl') {
    return { kind: 'wsl', distro: null }
  }
  const [prefix, ...rest] = value.split(':')
  const body = rest.join(':')
  if (body.length === 0) {
    return null
  }
  if (prefix === 'wsl') {
    return { kind: 'wsl', distro: normalizeDistro(decodeURIComponent(body)) }
  }
  if (prefix === 'ssh') {
    return { kind: 'ssh', targetId: decodeURIComponent(body) }
  }
  if (prefix === 'runtime') {
    return { kind: 'runtime', environmentId: decodeURIComponent(body) }
  }
  return null
}

/** null when the value is not a route key this module issued — never a coerced
 *  fallback, because a mis-parsed route names someone else's subscription. */
export function parseRouteKey(value: unknown): RouteKey | null {
  if (typeof value !== 'string') {
    return null
  }
  const separator = value.indexOf('/')
  const at = value.lastIndexOf('@')
  if (separator <= 0 || at <= separator + 1) {
    return null
  }
  let provider: string
  let account: RouteAccount | null
  let host: RouteHost | null
  try {
    provider = decodeURIComponent(value.slice(0, separator))
    account = parseAccount(value.slice(separator + 1, at))
    host = parseHost(value.slice(at + 1))
  } catch {
    // decodeURIComponent throws on a malformed escape ("%zz"). A route key is
    // untrusted input at the DB and CLI boundaries, so this must be a rejection
    // rather than an exception thrown at the caller.
    return null
  }
  if (!provider || !account || !host) {
    return null
  }
  const parsed: RouteKey = { provider: provider as TuiAgent, account, host }
  // Canonical-form check: accept only what `formatRouteKey` would itself emit.
  // Without it, `claude/managed:a@b@local` and `claude/managed:a%40b@local`
  // both parse to the same route, so a unique index on `target_route_key` would
  // happily hold two rows for one logical subscription — and a reservation
  // could be claimed twice.
  return formatRouteKey(parsed) === value ? parsed : null
}

export function routeKeysEqual(a: RouteKey, b: RouteKey): boolean {
  return formatRouteKey(a) === formatRouteKey(b)
}

/** Health may be account-scoped (§3a rule 1) — this is that projection, and it
 *  deliberately drops the host so one exhausted subscription is not reported as
 *  healthy merely because a different host has not hit it yet. */
export function formatRouteAccountScope(key: RouteKey): string {
  return `${encodeURIComponent(key.provider)}/${formatAccount(key.account)}`
}
