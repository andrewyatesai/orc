/**
 * Issues and checks fleet grants (§6.6 of
 * docs/reference/alab-auto-mode-design.md). R0 ships this minimal issuer because
 * R0's own done-criterion is one agent driving another: without a mint path the
 * gate either cannot run or runs ungated, and ungated is how it would ship.
 *
 * In-memory on purpose. A grant must not survive the runtime that issued it —
 * a durable grant would outlive the manager generation it was bound to, which
 * is exactly what `generation` exists to prevent.
 *
 * Lookup is a plain Map keyed by secret. That is not constant-time, and per
 * §6.6 it does not need to be: grants are not a same-UID security boundary, and
 * any process that could exploit the timing can already read the owner token.
 */

import { randomBytes } from 'node:crypto'
import {
  decideFleetGrant,
  type FleetGrant,
  type FleetGrantCheckRequest,
  type FleetGrantDecision,
  type FleetGrantOp,
  type FleetGrantTarget
} from '../../shared/fleet-grant'

/** Bounds a runaway issuer; far above any real fleet, so hitting it is a bug. */
const MAX_LIVE_GRANTS = 512
const DEFAULT_GRANT_TTL_MS = 12 * 60 * 60_000

export type IssueFleetGrantArgs = {
  runId: string
  generation: number
  ops: readonly FleetGrantOp[]
  targets: readonly FleetGrantTarget[]
  ttlMs?: number | null
}

export type FleetGrantAuditHook = (event: {
  action: 'issued' | 'revoked'
  grantId: string
  runId: string
  generation: number
  ops: readonly FleetGrantOp[]
  targetHandles: readonly string[]
}) => void

export class FleetGrantRegistry {
  private readonly bySecret = new Map<string, FleetGrant>()
  private readonly byId = new Map<string, FleetGrant>()
  /** Current generation per run. Held here rather than passed by callers: an
   *  agent presenting a grant cannot be trusted to say which generation is
   *  current, and that is the whole value of the field. */
  private readonly generationByRun = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onAudit: FleetGrantAuditHook | null = null
  ) {}

  /** Current generation for a run; runs start at 0 so an unknown run is not a
   *  special case at the check site. */
  currentGeneration(runId: string): number {
    return this.generationByRun.get(runId) ?? 0
  }

  /**
   * Replaces a manager: every grant of the outgoing generation is revoked before
   * the new generation exists, so there is no window in which two generations
   * are simultaneously valid.
   */
  bumpGeneration(runId: string): number {
    const next = this.currentGeneration(runId) + 1
    this.revokeRun(runId)
    this.generationByRun.set(runId, next)
    return next
  }

  issue(args: IssueFleetGrantArgs): FleetGrant {
    this.pruneExpired()
    this.generationByRun.set(
      args.runId,
      Math.max(this.currentGeneration(args.runId), args.generation)
    )
    if (this.byId.size >= MAX_LIVE_GRANTS) {
      throw new Error(`fleet grant registry is full (${MAX_LIVE_GRANTS} live grants)`)
    }
    const ttlMs = args.ttlMs === null ? null : (args.ttlMs ?? DEFAULT_GRANT_TTL_MS)
    const grant: FleetGrant = {
      grantId: `grant_${randomBytes(8).toString('hex')}`,
      runId: args.runId,
      generation: args.generation,
      // Copied, not aliased: a caller mutating its own array afterwards must not
      // widen a grant that has already been issued and audited.
      ops: [...args.ops],
      targets: args.targets.map((target) => ({ ...target })),
      secret: randomBytes(32).toString('base64url'),
      expiresAt: ttlMs === null ? null : this.now() + ttlMs,
      revokedAt: null
    }
    this.bySecret.set(grant.secret, grant)
    this.byId.set(grant.grantId, grant)
    this.onAudit?.({
      action: 'issued',
      grantId: grant.grantId,
      runId: grant.runId,
      generation: grant.generation,
      ops: grant.ops,
      targetHandles: grant.targets.map((target) => target.handle)
    })
    return grant
  }

  /**
   * The whole point of re-checking: callers must invoke this immediately before
   * Enter or a signal, not only when a long operation starts. A grant revoked
   * mid-paste has to stop the Enter that follows it.
   */
  check(
    secret: string | null | undefined,
    request: Omit<FleetGrantCheckRequest, 'now' | 'generation'>
  ): FleetGrantDecision {
    if (!secret) {
      return { allowed: false, reason: 'no-grant-presented' }
    }
    const grant = this.bySecret.get(secret) ?? null
    return decideFleetGrant(grant, {
      ...request,
      generation: grant ? this.currentGeneration(grant.runId) : 0,
      now: this.now()
    })
  }

  revoke(grantId: string): boolean {
    const grant = this.byId.get(grantId)
    if (!grant || grant.revokedAt !== null) {
      return false
    }
    // Why the secret stays mapped: a revoked grant must answer `revoked`, not
    // `unknown-grant`. The caller is an agent, and "I have never heard of that"
    // invites a re-mint, where "it was revoked" is a stop.
    grant.revokedAt = this.now()
    this.onAudit?.({
      action: 'revoked',
      grantId: grant.grantId,
      runId: grant.runId,
      generation: grant.generation,
      ops: grant.ops,
      targetHandles: grant.targets.map((target) => target.handle)
    })
    return true
  }

  /** Atomic revocation before manager replacement (§6.6): every grant of the
   *  outgoing generation dies before the incoming one issues any. */
  revokeRun(runId: string, options: { belowGeneration?: number } = {}): number {
    let revoked = 0
    // Snapshot the ids, not the map: revoke() mutates entries while we iterate.
    for (const grant of Array.from(this.byId.values())) {
      const generationMatches =
        options.belowGeneration === undefined || grant.generation < options.belowGeneration
      if (grant.runId === runId && generationMatches && this.revoke(grant.grantId)) {
        revoked++
      }
    }
    return revoked
  }

  /** Retains revoked/expired records so a stale caller is told `revoked` rather
   *  than the misleading `unknown-grant`, but not forever. */
  private pruneExpired(): void {
    const now = this.now()
    for (const [grantId, grant] of this.byId) {
      const dead = grant.revokedAt !== null || (grant.expiresAt !== null && now >= grant.expiresAt)
      if (dead && now - (grant.revokedAt ?? grant.expiresAt ?? now) > DEFAULT_GRANT_TTL_MS) {
        this.byId.delete(grantId)
        this.bySecret.delete(grant.secret)
      }
    }
  }
}
