/**
 * `fleet.grant*` — R0's minimal grant issuer (§6.6 of
 * docs/reference/alab-auto-mode-design.md).
 *
 * R2 replaces the caller with a ManagerSupervisor that mints on launch; this
 * exists because R0's own done-criterion is one agent driving another, and
 * without an issuer that gate either cannot run or runs ungated. Ungated is the
 * one outcome that would ship silently.
 *
 * The secret is returned exactly once, at mint. Nothing reads it back — a
 * listable bearer value would make revocation meaningless.
 */
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import { FLEET_GRANT_OPS, type FleetGrantOp } from '../../../../shared/fleet-grant'

const GrantIssueParams = z.object({
  run: requiredString('Missing run id'),
  terminals: z.array(requiredString('Missing terminal handle')).min(1),
  ops: z.array(z.enum(FLEET_GRANT_OPS as unknown as [FleetGrantOp, ...FleetGrantOp[]])).min(1),
  ttlMs: OptionalFiniteNumber,
  /** Fleet-owned panes only — a pane the human already had open must stay pinned
   *  to the incarnation the grant was actually reviewed against. */
  anyIncarnation: z.boolean().optional()
})

const GrantRevokeParams = z.object({
  grant: z.string().min(1).optional(),
  run: z.string().min(1).optional()
})

export const FLEET_GRANT_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'fleet.grantIssue',
    params: GrantIssueParams,
    handler: (params, { runtime }) => {
      runtime.assertFleetVerbEnabled('fleet.grantIssue')
      const grant = runtime.issueFleetGrant({
        runId: params.run,
        ops: params.ops,
        terminals: params.terminals,
        ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
        ...(params.anyIncarnation !== undefined ? { anyIncarnation: params.anyIncarnation } : {})
      })
      return {
        grantId: grant.grantId,
        runId: grant.runId,
        generation: grant.generation,
        ops: grant.ops,
        targets: grant.targets,
        expiresAt: grant.expiresAt,
        // Returned once. Present it as `grant` on terminal.submitAgentPrompt, or
        // export it as ORCA_FLEET_GRANT for the CLI face to pick up.
        secret: grant.secret
      }
    }
  }),
  defineMethod({
    name: 'fleet.grantRevoke',
    params: GrantRevokeParams,
    handler: (params, { runtime }) => {
      runtime.assertFleetVerbEnabled('fleet.grantRevoke')
      if (params.grant) {
        return { revoked: runtime.revokeFleetGrant(params.grant) ? 1 : 0 }
      }
      if (params.run) {
        return { revoked: runtime.revokeFleetGrantsForRun(params.run) }
      }
      throw new Error('fleet.grantRevoke needs either --grant or --run')
    }
  })
]
