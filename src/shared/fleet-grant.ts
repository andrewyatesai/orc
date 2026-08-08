/**
 * Fleet grants — the authority a driving agent presents to act on another
 * agent's pane (§6.6 of docs/reference/alab-auto-mode-design.md).
 *
 * **What this is not.** Not a same-UID security boundary. Any local process can
 * read the runtime owner token (0600, same user), so a determined local process
 * can forge a call. Grants exist for accidental-scope prevention, revocation UX
 * and audit. Containment against a hostile local process is an OS-sandbox
 * problem and is out of scope — stated here rather than implied away.
 *
 * **Why a bearer value.** Every RPC caller authenticates with the one shared
 * `authToken` and there is no authenticated per-caller subject, so there is
 * nothing to bind authority to except a value the caller presents per call.
 *
 * The grant binds to (runId, generation, target pane incarnation). The
 * incarnation component is what stops a grant minted for a pane from surviving
 * that pane's respawn — the new process is not the one the human authorized.
 */

export const FLEET_GRANT_ENV_VAR = 'ORCA_FLEET_GRANT'

export type FleetGrantOp = 'read' | 'write' | 'signal'

export const FLEET_GRANT_OPS: readonly FleetGrantOp[] = ['read', 'write', 'signal']

export function isFleetGrantOp(value: unknown): value is FleetGrantOp {
  return typeof value === 'string' && (FLEET_GRANT_OPS as readonly string[]).includes(value)
}

/** One authorized pane. `incarnationId` null means "any incarnation of this
 *  handle" and is reserved for panes the fleet itself created and still owns —
 *  never for a pane the human already had open. */
export type FleetGrantTarget = {
  handle: string
  incarnationId: string | null
}

export type FleetGrant = {
  grantId: string
  runId: string
  /** ManagerSupervisor generation in R2; the issuer's own counter in R0. Bumping
   *  it is what atomically invalidates every grant of a replaced manager. */
  generation: number
  ops: readonly FleetGrantOp[]
  targets: readonly FleetGrantTarget[]
  /** The bearer value the caller presents. Never logged, never audited raw. */
  secret: string
  /** null = no expiry; R0's test driver mints short-lived grants anyway. */
  expiresAt: number | null
  revokedAt: number | null
}

export type FleetGrantDenialReason =
  | 'no-grant-presented'
  | 'unknown-grant'
  | 'revoked'
  | 'expired'
  | 'wrong-generation'
  | 'op-not-granted'
  | 'target-not-granted'
  | 'incarnation-changed'

export type FleetGrantDecision =
  | { allowed: true; grantId: string; runId: string }
  | { allowed: false; reason: FleetGrantDenialReason }

export type FleetGrantCheckRequest = {
  op: FleetGrantOp
  handle: string
  /** The incarnation the operation is about to act on. A grant pinned to a
   *  different one is refused — that is the respawn guard. */
  incarnationId: string | null
  generation: number
  now: number
}

function targetMatches(target: FleetGrantTarget, request: FleetGrantCheckRequest): boolean {
  if (target.handle !== request.handle) {
    return false
  }
  return target.incarnationId === null || target.incarnationId === request.incarnationId
}

/**
 * Pure decision, so both the R0 check and R2's manager path share one rule and
 * it is testable without a runtime. Order matters: identity failures are
 * reported before scope failures so a revoked grant never reads as "you just
 * asked for the wrong pane".
 */
export function decideFleetGrant(
  grant: FleetGrant | null,
  request: FleetGrantCheckRequest
): FleetGrantDecision {
  if (!grant) {
    return { allowed: false, reason: 'unknown-grant' }
  }
  if (grant.revokedAt !== null) {
    return { allowed: false, reason: 'revoked' }
  }
  if (grant.expiresAt !== null && request.now >= grant.expiresAt) {
    return { allowed: false, reason: 'expired' }
  }
  if (grant.generation !== request.generation) {
    return { allowed: false, reason: 'wrong-generation' }
  }
  if (!grant.ops.includes(request.op)) {
    return { allowed: false, reason: 'op-not-granted' }
  }
  const target = grant.targets.find((candidate) => candidate.handle === request.handle)
  if (!target) {
    return { allowed: false, reason: 'target-not-granted' }
  }
  if (!targetMatches(target, request)) {
    return { allowed: false, reason: 'incarnation-changed' }
  }
  return { allowed: true, grantId: grant.grantId, runId: grant.runId }
}

/** Human-facing reason text. Denials must name the fix, because the caller is an
 *  agent that will otherwise retry the same refused call. */
export function describeFleetGrantDenial(reason: FleetGrantDenialReason): string {
  switch (reason) {
    case 'no-grant-presented':
      return `no fleet grant presented — set ${FLEET_GRANT_ENV_VAR} to a grant issued for this run`
    case 'unknown-grant':
      return 'the presented fleet grant is not known to this runtime'
    case 'revoked':
      return 'the presented fleet grant was revoked'
    case 'expired':
      return 'the presented fleet grant has expired'
    case 'wrong-generation':
      return 'the presented fleet grant belongs to a replaced manager generation'
    case 'op-not-granted':
      return 'the presented fleet grant does not carry this operation class'
    case 'target-not-granted':
      return 'the presented fleet grant does not cover this terminal'
    case 'incarnation-changed':
      return 'the target terminal restarted after the grant was issued'
  }
}

/**
 * Removes the grant from an environment bag. Applied at every Orca-controlled
 * spawn boundary even when a caller explicitly supplied it, because
 * `terminal.create` accepts caller env and a worker must never inherit the
 * authority to drive its siblings.
 *
 * The guarantee this supports is "Orca-managed worker PTYs", not "any worker":
 * a child the manager spawns itself inherits the manager's environment and Orca
 * has no boundary there. Narrowed deliberately so the promise is true.
 */
export function stripFleetGrantEnv<T extends Record<string, string> | undefined>(env: T): T {
  if (!env || !(FLEET_GRANT_ENV_VAR in env)) {
    return env
  }
  const stripped = { ...env }
  delete stripped[FLEET_GRANT_ENV_VAR]
  return stripped as T
}

/** True when a bag would smuggle authority into durable launch config. Used as
 *  an assertion at the persistence seam, where a resumed pane would otherwise
 *  come back holding a grant. */
export function containsFleetGrantEnv(env: Record<string, string> | null | undefined): boolean {
  return Boolean(env && FLEET_GRANT_ENV_VAR in env)
}
