import { defineMethod, type RpcAnyMethod } from '../core'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'
import { assertLocalCallerScope, getCallerScope } from '../../runtime-caller-scope'

/**
 * Why local-only rather than "no host object": these mint and read relay
 * credentials for the machine running Orca, which is a host object — it just
 * isn't one a selector can name, so there is nothing to bound them to. Today
 * only a paired-device socket carries a pairing context at all, but that is the
 * transport's wiring rather than a bound, and wiring is what changes.
 */
function assertPairingIsLocal(): void {
  assertLocalCallerScope(getCallerScope(), 'device pairing for the machine running Orca')
}

export const PAIRING_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'pairing.getEndpoints',
    params: PairingGetEndpointsParamsSchema,
    handler: async (params, ctx) => {
      assertPairingIsLocal()
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.getEndpoints(params)
    }
  }),
  defineMethod({
    name: 'pairing.provisionRelay',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      assertPairingIsLocal()
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.provisionRelay(params)
    }
  })
]
