// TS dispatch for the policy parity module: drives the LIVE
// src/main/story-world/play-path-guard.ts and src/shared/fleet-grant.ts against
// the Rust port (orca-policy).
//
// These two are the fleet's authority decisions — "may this file be served to a
// child's browser", "may this caller type into that agent's terminal" — so the
// differential harness matters more here than for a formatter: a divergence is a
// security divergence, and the corpus already caught one (the two sides
// disagreed about WHERE percent-decoding happens).
//
// Only the LEXICAL half of the play-path decision is compared. The realpath half
// needs a filesystem, so `realpath` is stubbed to identity and containment
// against a symlinked world is covered by the guard's own suite.

import { relative, sep } from 'node:path'
import { decidePlayPath } from '../../../src/main/story-world/play-path-guard'
import { isAllowedPlayHost } from '../../../src/main/story-world/play-path-guard'
import {
  decideFleetGrant,
  type FleetGrant,
  type FleetGrantOp
} from '../../../src/shared/fleet-grant'

/** Any absolute root works; the compared output is the path RELATIVE to it. */
const ROOT = '/r'

type GrantVector = {
  generation?: number
  ops?: string[]
  targets?: { handle?: string; incarnation?: string | null }[]
  expiresAtMs?: number | null
  revoked?: boolean
}

/**
 * Rebuilds the vector's grant into the live TS shape. `grantId`/`runId`/`secret`
 * are echoes, not inputs to the decision, so they are filled with constants and
 * dropped from the comparison below.
 */
function toFleetGrant(raw: GrantVector): FleetGrant {
  return {
    grantId: 'g',
    runId: 'r',
    secret: 's',
    generation: raw.generation ?? 0,
    ops: (raw.ops ?? []) as readonly FleetGrantOp[],
    targets: (raw.targets ?? []).map((target) => ({
      handle: target.handle ?? '',
      incarnationId: target.incarnation ?? null
    })),
    expiresAt: raw.expiresAtMs ?? null,
    // The Rust core carries a boolean; the TS grant carries the revocation
    // TIMESTAMP, and only its null-ness is read. 1 is any non-null instant.
    revokedAt: raw.revoked === true ? 1 : null
  }
}

export function dispatch(fn: string, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>
  switch (fn) {
    case 'decidePlayPathLexical': {
      const decision = decidePlayPath({
        root: ROOT,
        requestPath: String(args.requestPath ?? ''),
        realpath: (path) => path
      })
      if (!decision.allowed) {
        return { allowed: false, reason: decision.reason }
      }
      // Separators normalized to `/` so the compared value is the same on
      // Windows, where `resolve`/`relative` return backslashes.
      return {
        allowed: true,
        relativePath: relative(ROOT, decision.absolutePath).split(sep).join('/')
      }
    }
    case 'isAllowedPlayHost':
      return isAllowedPlayHost(
        args.host === undefined ? undefined : String(args.host),
        Number(args.expectedPort ?? 0)
      )
    case 'decideFleetGrant': {
      const grant =
        args.grant === null || args.grant === undefined
          ? null
          : toFleetGrant(args.grant as GrantVector)
      const decision = decideFleetGrant(grant, {
        op: String(args.op ?? '') as FleetGrantOp,
        handle: String(args.handle ?? ''),
        incarnationId: args.incarnation === undefined ? null : (args.incarnation as string | null),
        generation: Number(args.currentGeneration ?? 0),
        now: Number(args.nowMs ?? 0)
      })
      // Projected to the decision itself. `grantId`/`runId` are echoes of the
      // input that the Rust core deliberately does not carry.
      return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason }
    }
    default:
      return { __parity_error__: `unknown function ${fn}` }
  }
}
