import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { persistRelayHost } from './mobile-endpoint-supervisor-support'
import { selectDialableRelayCredentials } from './mobile-relay-credential-selection'
import {
  dialRelayCredential,
  type RelayCredentialDialContext
} from './mobile-relay-credential-dial'
import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import * as recoveryPresentation from './mobile-relay-recovery-presentation'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'

const DIRECT_PROBE_INTERVAL_MS = 15_000
const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000

export class MobileEndpointSupervisor {
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private credentialRotationInFlight = false
  private relayRotationPending = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly relayReconnect: RelayReconnectController
  private readonly leaseRotation: RelayLeaseRotationTimer

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now(), {
      directSuccessesRequired: 3,
      directObservationMs: DIRECT_OBSERVATION_MS,
      failureCooldownMs: FAILURE_COOLDOWN_MS,
      minimumDwellMs: MINIMUM_DWELL_MS
    })
    this.relayReconnect = new RelayReconnectController(dependencies, this.recoverRelay.bind(this))
    this.leaseRotation = new RelayLeaseRotationTimer(dependencies, () => {
      this.relayRotationPending = true
      void this.recoverRelay(true)
    })
  }

  async start(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.host.id).catch(() => null)
    if (this.stopped || !this.host.relay) {
      return
    }
    // Why: a Keychain race at open must not kill relay recovery for the whole
    // process lifetime; each recovery attempt re-reads the durable bundle.
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        if (this.logical.getActivePath() !== 'relay') {
          void this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
        }
        this.scheduleDirectProbe()
      } else {
        // Why: the direct client enters reconnecting after its first failed
        // dial and may never publish disconnected while its retry loop lives.
        recoveryPresentation.onActiveFailure(this.logical, this.relayReconnect, state, this.bundle)
        this.relayReconnect.handleStateFailure(this.logical, state)
      }
    })
    if (this.relayReconnect.needsRecovery(this.logical.getState())) {
      // Why: the first direct dial can fail while encrypted relay credentials
      // are still loading, before the supervisor subscribes to state changes.
      await this.recoverRelay()
    } else {
      this.scheduleDirectProbe()
    }
  }

  setForeground(foreground: boolean): void {
    const wasForeground = this.foreground
    this.foreground = foreground
    if (foreground) {
      this.relayReconnect.handleForeground(this.logical, wasForeground)
      this.scheduleDirectProbe(0)
    } else {
      // Why: background phones must not hold billed relay data splices.
      this.relayReconnect.suspendActiveRelay(this.logical)
      this.clearDirectProbeTimer()
      this.relayReconnect.clear()
      this.leaseRotation.clear()
      this.logical.setRecoveryPath(null)
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.clearDirectProbeTimer()
    this.relayReconnect.clear()
    this.leaseRotation.clear()
    this.logical.setRecoveryPath(null)
  }

  private async recoverRelay(forceReplacement = false): Promise<void> {
    // Why: connecting/handshaking is live direct progress; a relay dial would race it.
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      !this.host.relay ||
      (!forceReplacement && !this.relayReconnect.needsRecovery(this.logical.getState()))
    ) {
      return
    }
    // Why: revival and lease timers can overlap resume failures; one shared cooldown
    // prevents PEER_DROPPED/LIMIT_EXCEEDED reconnect churn.
    if (this.relayReconnect.shouldDefer()) {
      return
    }
    this.operationInFlight = true
    let lastError: Error | null = null
    let retryAfterOperation = false
    try {
      // Why: re-read the durable bundle each gated attempt and adopt a fresher
      // one — a relay-only phone has no direct path to refresh a snapshot.
      const selection = await selectDialableRelayCredentials({
        bundle: this.bundle,
        controller: this.relayReconnect,
        readBundle: () => this.dependencies.readBundle(this.host.id)
      })
      this.bundle = selection.bundle
      if (selection.credentials.length === 0) {
        // Why: no socket can open, so a "Connecting via Relay…" verdict would lie.
        this.logical.setRecoveryPath(null)
      } else if (this.foreground && !this.stopped) {
        // Why: an eligible credential backs a genuine relay dial — name the path
        // the user is now waiting on so a failed direct hint stops masquerading.
        this.logical.setRecoveryPath('relay')
      }
      for (const credential of selection.credentials) {
        const result = await dialRelayCredential(credential, this.relayDialContext())
        if (result.ok) {
          retryAfterOperation = this.logical.getState() !== 'connected'
          return
        }
        lastError = result.error
        if (this.relayReconnect.shouldTryGraceAfterRelayFailure(result.error)) {
          // Why: a rejected version stays invalid; retry only the grace credential.
          this.relayReconnect.recordRejectedCredential(credential.version)
        } else {
          break
        }
      }
      if (selection.credentials.length > 0) {
        // Why: cleanup may happen while a relay dial is awaiting the network;
        // record its outcome without recreating a foreground retry timer.
        const scheduleRetry = !forceReplacement && this.foreground && !this.stopped
        this.relayReconnect.registerFailure(lastError, scheduleRetry)
        // Why: a rejected credential gates recovery until a fresh one is durable —
        // stop presenting a Relay wait the dial loop can no longer honor.
        recoveryPresentation.clearIfCredentialBlocked(this.logical, this.relayReconnect)
      }
    } finally {
      this.operationInFlight = false
      if (forceReplacement && this.relayRotationPending && !this.stopped && this.foreground) {
        this.leaseRotation.armRetry(this.relayReconnect.retryDelayMs(5000))
      }
      // Why: the active relay can drop while migration follow-up still owns the mutex.
      if (retryAfterOperation && !this.stopped && this.foreground) {
        void this.recoverRelay()
      }
    }
  }

  private relayDialContext(): RelayCredentialDialContext {
    return {
      logical: this.logical,
      dependencies: this.dependencies,
      relayReconnect: this.relayReconnect,
      leaseRotation: this.leaseRotation,
      hysteresis: this.hysteresis,
      isStopped: () => this.stopped,
      isForeground: () => this.foreground,
      getHost: () => this.host,
      setHost: (host) => {
        this.host = host
      },
      getBundle: () => this.bundle,
      setBundle: (bundle) => {
        this.bundle = bundle
      },
      clearRelayRotationPending: () => {
        this.relayRotationPending = false
      },
      scheduleDirectProbe: () => this.scheduleDirectProbe()
    }
  }

  private scheduleDirectProbe(delayMs = DIRECT_PROBE_INTERVAL_MS): void {
    if (
      this.stopped ||
      !this.foreground ||
      this.logical.getActivePath() !== 'relay' ||
      this.probeTimer
    ) {
      return
    }
    this.probeTimer = this.dependencies.setTimer(() => {
      this.probeTimer = null
      void this.probeDirect()
    }, delayMs)
  }

  private async probeDirect(): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      !this.hysteresis.canProbe(this.dependencies.now())
    ) {
      this.scheduleDirectProbe()
      return
    }
    this.operationInFlight = true
    let successful: Awaited<ReturnType<typeof openAuthenticatedDirectEndpoint>> = null
    try {
      const openDirect = this.dependencies.openDirect
      successful = await openAuthenticatedDirectEndpoint(this.host, openDirect, 12_000)
      if (!successful) {
        this.hysteresis.recordDirectFailure(this.dependencies.now())
        return
      }
      if (!this.hysteresis.recordDirectSuccess(this.dependencies.now())) {
        successful.client.close()
        return
      }
      await this.logical.migrateTo(successful.client, successful.path)
      successful = null
      this.hysteresis.recordMigration(this.dependencies.now())
      this.leaseRotation.clear()
      this.relayRotationPending = false
      await this.rotateCredentialIfNeeded(this.relayReconnect.resetForDirectConnection())
    } finally {
      successful?.client.close()
      this.operationInFlight = false
      // Why: a relay drop or backoff timer can arrive while the direct probe owns the mutex.
      if (this.relayRotationPending || this.logical.getState() !== 'connected') {
        void this.recoverRelay(this.relayRotationPending)
      }
      this.scheduleDirectProbe()
    }
  }

  private async rotateCredentialIfNeeded(force = false): Promise<void> {
    if (
      this.stopped ||
      this.credentialRotationInFlight ||
      !this.bundle ||
      this.logical.getActivePath() === 'relay' ||
      (!force && !mobileRelayCredentialNeedsRotation(this.bundle, this.dependencies.now()))
    ) {
      return
    }
    this.credentialRotationInFlight = true
    let credentialRefreshed = false
    try {
      const result = await rotateMobileRelayCredential({
        client: this.logical,
        bundle: this.bundle,
        writeBundle: this.dependencies.writeBundle,
        randomBytes: this.dependencies.randomBytes
      })
      this.bundle = result.bundle
      // Why: a scheduled rotation can finish after the old credential enters the rejection gate.
      credentialRefreshed = true
      this.host = await persistRelayHost(this.host, result.relay, this.dependencies.saveHost)
    } catch {
      // Why: pending material remains durable; the next authenticated direct
      // opportunity must reconcile it before creating another install key.
    } finally {
      if (credentialRefreshed) {
        this.relayReconnect.completeCredentialRefresh()
      }
      this.credentialRotationInFlight = false
      if (
        credentialRefreshed &&
        !this.stopped &&
        this.foreground &&
        this.relayReconnect.needsRecovery(this.logical.getState())
      ) {
        void this.recoverRelay()
      }
    }
  }

  private clearDirectProbeTimer(): void {
    if (this.probeTimer) {
      this.dependencies.clearTimer(this.probeTimer)
      this.probeTimer = null
    }
  }
}
