// Why: an SSH pane's shell is readable and writable by whoever holds that remote
// account, so a command arriving from it must not be able to reach objects on
// the user's laptop or on a different SSH target. The bound is the machine
// boundary the credential already spans: a remote call may reach objects owned
// by its own connection, nothing else. Enforcement lives where a selector
// becomes an object (the resolvers), never on argv — free text like
// `--text orca` never reaches a resolver, and a call that names nothing still
// resolves one.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export type RuntimeCallerScope =
  /** In-app, renderer, or a CLI run on this machine — unrestricted. */
  | { kind: 'local' }
  /** A pane on this SSH target; may reach objects that target owns. */
  | { kind: 'ssh'; connectionId: string }
  /** Arrived over SSH with no attributable owner — may reach nothing. */
  | { kind: 'unattributed' }

export const LOCAL_CALLER_SCOPE: RuntimeCallerScope = { kind: 'local' }
export const UNATTRIBUTED_CALLER_SCOPE: RuntimeCallerScope = {
  kind: 'unattributed'
}

export const CALLER_SCOPE_DENIED_CODE = 'caller_scope_denied'

/** Refusal — never a silent redirect: the message names the object and its owner. */
export class CallerScopeDeniedError extends Error {
  readonly code = CALLER_SCOPE_DENIED_CODE

  constructor(message: string) {
    super(message)
  }
}

/**
 * Owner of a host-side object. `null` means the local machine; `undefined`
 * means ownership could not be determined, which a bounded caller is refused
 * rather than granted.
 */
export type CallerScopeObjectOwner = string | null | undefined

const callerScopeStorage = new AsyncLocalStorage<RuntimeCallerScope>()

/** Absent context is a local call: renderer IPC and local CLI never set one. */
export function getCallerScope(): RuntimeCallerScope {
  return callerScopeStorage.getStore() ?? LOCAL_CALLER_SCOPE
}

export function runWithCallerScope<T>(scope: RuntimeCallerScope, fn: () => T): T {
  return callerScopeStorage.run(scope, fn)
}

export function isBoundedCallerScope(scope: RuntimeCallerScope): boolean {
  return scope.kind !== 'local'
}

export function callerScopeReaches(
  scope: RuntimeCallerScope,
  owner: CallerScopeObjectOwner
): boolean {
  if (scope.kind === 'local') {
    return true
  }
  if (scope.kind === 'unattributed') {
    return false
  }
  return typeof owner === 'string' && owner === scope.connectionId
}

function describeOwner(owner: CallerScopeObjectOwner): string {
  if (owner === null) {
    return 'the local machine'
  }
  if (owner === undefined) {
    return 'an owner Orca could not determine'
  }
  return `SSH host ${owner}`
}

/** Refuses when `owner` is outside `scope`. `subject` names the denied object. */
export function assertCallerScopeReaches(
  scope: RuntimeCallerScope,
  owner: CallerScopeObjectOwner,
  subject: string
): void {
  if (callerScopeReaches(scope, owner)) {
    return
  }
  if (scope.kind === 'unattributed') {
    throw new CallerScopeDeniedError(
      `Refused: ${subject}. This command arrived over SSH without a pane identity, so Orca cannot tell which host it may act on.`
    )
  }
  throw new CallerScopeDeniedError(
    `Refused: ${subject} belongs to ${describeOwner(owner)}, but this command came from SSH host ${
      (scope as { connectionId: string }).connectionId
    }. A remote pane may only reach worktrees, repos and terminals on its own host.`
  )
}

/** Refuses a whole command group that has no host selector to bound. */
export function assertLocalCallerScope(scope: RuntimeCallerScope, subject: string): void {
  if (scope.kind === 'local') {
    return
  }
  const from =
    scope.kind === 'ssh' ? `SSH host ${scope.connectionId}` : 'an SSH pane Orca could not attribute'
  throw new CallerScopeDeniedError(
    `Refused: ${subject} drives the machine running Orca and has no host selector to bound, but this command came from ${from}.`
  )
}

// Why: the SSH bridge runs the real host CLI as a subprocess, which reconnects
// over the runtime's shared socket — the passthrough's async context does not
// reach it. A single-use auth token issued per invocation is what re-attributes
// those requests, so scope is re-established inside the request the subprocess
// makes rather than inferred from ambient state.
const scopedCallerTokens = new Map<string, RuntimeCallerScope>()

export function registerScopedCallerToken(scope: RuntimeCallerScope): {
  token: string
  dispose: () => void
} {
  const token = randomBytes(24).toString('hex')
  scopedCallerTokens.set(token, scope)
  return {
    token,
    dispose: () => {
      scopedCallerTokens.delete(token)
    }
  }
}

export function resolveScopedCallerToken(token: string): RuntimeCallerScope | null {
  const candidate = Buffer.from(token, 'utf8')
  for (const [registered, scope] of scopedCallerTokens) {
    const expected = Buffer.from(registered, 'utf8')
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return scope
    }
  }
  return null
}

/** Test seam only — production tokens are disposed by the invocation that minted them. */
export function clearScopedCallerTokensForTest(): void {
  scopedCallerTokens.clear()
}
