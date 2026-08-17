import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { applyResumeConfirmation } from './mobile-relay-credential-rotation'
import {
  encodeBase64Url,
  isDirectorResolutionFailure,
  persistRelayHost,
  toError
} from './mobile-endpoint-supervisor-support'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export type RelayDialCredential = { token: string; version: number }
export type RelayDialOutcome = { ok: true } | { ok: false; error: Error }

// The mutable supervisor state and collaborators a single relay-credential dial
// reads, migrates through, and writes back. Kept explicit so the dial pipeline
// stays testable and out of the supervisor's line budget.
export interface RelayCredentialDialContext {
  readonly logical: StableLogicalRpcClient
  readonly dependencies: MobileEndpointSupervisorDependencies
  readonly relayReconnect: RelayReconnectController
  readonly leaseRotation: RelayLeaseRotationTimer
  readonly hysteresis: MobileEndpointHysteresis
  isStopped(): boolean
  isForeground(): boolean
  getHost(): HostProfile
  setHost(host: HostProfile): void
  getBundle(): MobileRelayCredentialBundle | null
  setBundle(bundle: MobileRelayCredentialBundle): void
  clearRelayRotationPending(): void
  scheduleDirectProbe(): void
}

export async function dialRelayCredential(
  credential: RelayDialCredential,
  ctx: RelayCredentialDialContext
): Promise<RelayDialOutcome> {
  const first = await openAndMigrateRelay(credential, ctx)
  if (first.ok) {
    return first
  }
  const host = ctx.getHost()
  if (!isDirectorResolutionFailure(first.error) || !host.relay) {
    return first
  }
  try {
    const resolved = await ctx.dependencies.resolveRelay({
      relay: host.relay,
      resumeToken: credential.token
    })
    ctx.setHost(await persistRelayHost(host, resolved, ctx.dependencies.saveHost))
    return await openAndMigrateRelay(credential, ctx)
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

async function openAndMigrateRelay(
  credential: RelayDialCredential,
  ctx: RelayCredentialDialContext
): Promise<RelayDialOutcome> {
  // Why: director resolution and grace fallback can finish after background/stop.
  const host = ctx.getHost()
  const bundle = ctx.getBundle()
  if (ctx.isStopped() || !ctx.isForeground() || !host.relay || !bundle) {
    return { ok: false, error: new Error('relay state missing') }
  }
  const session = ctx.dependencies.openRelay(
    host.relay,
    credential,
    `confirm-${encodeBase64Url(ctx.dependencies.randomBytes(16))}`
  )
  try {
    await ctx.logical.migrateTo(session, 'relay')
    ctx.relayReconnect.setActiveSession(session)
    if (!ctx.isForeground()) {
      ctx.relayReconnect.suspendActiveRelay(ctx.logical)
    }
    ctx.clearRelayRotationPending()
    ctx.hysteresis.recordMigration(ctx.dependencies.now())
    const confirmation = session.getResumeConfirmation()
    if (confirmation) {
      const nextBundle = applyResumeConfirmation(bundle, credential.version, confirmation)
      ctx.setBundle(nextBundle)
      // Why: the relay is already authenticated; a SecureStore failure must
      // not open another socket or count against transport recovery backoff.
      await ctx.dependencies.writeBundle(nextBundle).catch(() => {})
    }
    // Why: async persistence can finish after stop/background; never recreate a stale timer.
    ctx.leaseRotation.scheduleFromLease(
      ctx.isStopped() || !ctx.isForeground() ? null : session.getLeaseExpiresAt()
    )
    ctx.scheduleDirectProbe()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: session.getFailure() ?? toError(error) }
  }
}
