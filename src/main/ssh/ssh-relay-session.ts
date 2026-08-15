/* oxlint-disable max-lines */
// Why: single authority for all relay lifecycle state per SSH target (previously scattered across module Maps/Sets with duplicated paths).

import type { BrowserWindow } from 'electron'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isRelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import type { RelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import type { SshPtyExitCallback } from '../providers/ssh-pty-provider-contract'
import { isSshPtyIdentityMismatchError, isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { SshGitProvider } from '../providers/ssh-git-provider'
import { agentHookServer } from '../agent-hooks/server'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD,
  isRemoteAgentHooksEnabled
} from '../../shared/agent-hook-relay'
import { _internals as openCodeInternals } from '../opencode/hook-service'
import { getPiAgentStatusExtensionSource } from '../pi/agent-status-extension-source'
import {
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  getSshPtyProvider,
  getPtyIdsForConnection,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
  deletePtyOwnership,
  setPtyOwnership,
  restorePtyIncarnation,
  isCurrentPtyExit
} from '../ipc/pty'
import {
  recordHiddenRendererPtyDataDrop,
  shouldDropHiddenRendererPtyData
} from '../ipc/pty-hidden-delivery-gate'
import type { PtyModelRestoreNeededEvent } from '../../shared/pty-model-restore-marker'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { notifyRemoteWorkspaceHandlers } from '../ipc/remote-workspace-events'
import { PortScanner } from './ssh-port-scanner'
import { isMainWindowVisible, onMainWindowBecameVisible } from '../window/main-window-visibility'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import { joinRemotePath, isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { makeRemoteDirectoryCommand } from './ssh-remote-commands'
import { createRemoteCliInstallPlan } from './ssh-remote-cli-launcher'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type DetectedPort,
  HOST_SLEEP_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
} from '../../shared/ssh-types'
import { forceStopRelayForTarget } from './ssh-relay-reset'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'
import { parseRemoteOrcaCliRequest } from './ssh-remote-cli-host-passthrough'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'

export type RelaySessionState = 'idle' | 'deploying' | 'ready' | 'reconnecting' | 'disposed'

type SshPtyExitPayload = Parameters<SshPtyExitCallback>[0]
type PendingPtyReattach = { exits: SshPtyExitPayload[] }

type RemoteCliBridgeEnv = {
  remoteHome: string
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  cliAuthToken: string
  hostPlatform: RemoteHostPlatform
  pathDelimiter?: ':' | ';'
}

type ExpectedPtyIdentity = { paneKey?: string; tabId?: string }

function expectedIdentityForLease(lease: {
  tabId?: string
  leafId?: string
}): ExpectedPtyIdentity | null {
  if (typeof lease.tabId !== 'string' || lease.tabId.length === 0) {
    return null
  }
  const paneKey =
    isValidTerminalTabId(lease.tabId) &&
    typeof lease.leafId === 'string' &&
    isTerminalLeafId(lease.leafId)
      ? makePaneKey(lease.tabId, lease.leafId)
      : undefined
  return {
    ...(paneKey ? { paneKey } : {}),
    tabId: lease.tabId
  }
}

type ForwardedReplayFingerprint = {
  fingerprint: string
  deliveredAt: number
}

export type SshRelayAiVaultHostInfo = {
  targetId: string
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
}

const RECONNECT_REPLAY_DUPLICATE_WINDOW_MS = 1000
const REPLAY_FINGERPRINT_EDGE_CHARS = 128

function normalizeRelayGracePeriodSeconds(graceTimeSeconds: number | undefined): number {
  const raw = graceTimeSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  const requested = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  return requested === 0
    ? 0
    : Math.max(
        MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
        Math.min(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, requested)
      )
}

export class SshRelaySession {
  private _state: RelaySessionState = 'idle'
  private mux: SshChannelMultiplexer | null = null
  private abortController: AbortController | null = null
  private muxDisposeCleanup: (() => void) | null = null
  // Why: hold the notification-handler disposer so teardownProviders can release it on reconnect/shutdown (symmetric with muxDisposeCleanup).
  private muxNotificationCleanup: (() => void) | null = null
  // Why: onStateChange never fires when the relay channel closes but SSH stays up; this callback lets ssh.ts drive relay-level reconnect.
  private _onRelayLost: ((targetId: string) => void) | null = null
  // Why: version mismatch is terminal, so it needs a separate callback from _onRelayLost (which expects a recoverable transport drop).
  private _onTerminalRelayError:
    | ((targetId: string, err: RelayVersionMismatchError) => void)
    | null = null
  private _onReady: ((targetId: string) => void) | null = null
  private portScanner: PortScanner | null = null
  private currentConnection: SshConnection | null = null
  private hostPlatform: RemoteHostPlatform | null = null
  private remoteCliBridgeEnv: RemoteCliBridgeEnv | null = null
  private forwardedReattachReplayByPty = new Map<string, ForwardedReplayFingerprint>()
  private pendingPtyReattaches = new Map<string, PendingPtyReattach>()
  // Why: host sleep must not overwrite an explicit "keep alive until reset" (0) with a bounded window.
  private configuredGraceSeconds = normalizeRelayGracePeriodSeconds(undefined)

  constructor(
    readonly targetId: string,
    private getMainWindow: () => BrowserWindow | null,
    private store: Store,
    private portForwardManager: SshPortForwardManager,
    private runtime?: OrcaRuntimeService,
    private onDetectedPortsChanged?: (
      targetId: string,
      ports: DetectedPort[],
      platform: string
    ) => void
  ) {}

  refreshEnvironment(
    getMainWindow: () => BrowserWindow | null,
    store: Store,
    portForwardManager: SshPortForwardManager,
    runtime?: OrcaRuntimeService,
    onDetectedPortsChanged?: (targetId: string, ports: DetectedPort[], platform: string) => void
  ): void {
    this.getMainWindow = getMainWindow
    this.store = store
    this.portForwardManager = portForwardManager
    this.runtime = runtime
    this.onDetectedPortsChanged = onDetectedPortsChanged
  }

  setOnRelayLost(cb: (targetId: string) => void): void {
    this._onRelayLost = cb
  }

  setOnTerminalRelayError(cb: (targetId: string, err: RelayVersionMismatchError) => void): void {
    this._onTerminalRelayError = cb
  }

  setOnReady(cb: (targetId: string) => void): void {
    this._onReady = cb
  }

  getState(): RelaySessionState {
    return this._state
  }

  // Why: dispose() can mutate _state across await points, so defeat TS's control-flow narrowing that would otherwise reject the 'disposed' check.
  private isDisposed(): boolean {
    return (this._state as RelaySessionState) === 'disposed'
  }

  private requireReadyConnection(): SshConnection {
    if (!this.currentConnection) {
      throw new Error('SSH connection is not active')
    }
    return this.currentConnection
  }

  getMux(): SshChannelMultiplexer | null {
    return this.mux
  }

  getHostPlatform(): RemoteHostPlatform | null {
    return this.remoteCliBridgeEnv?.hostPlatform ?? this.hostPlatform
  }

  getAiVaultHostInfo(): SshRelayAiVaultHostInfo | null {
    const env = this.remoteCliBridgeEnv
    if (!env) {
      return null
    }
    return {
      targetId: this.targetId,
      executionHostId: toSshExecutionHostId(this.targetId),
      remoteHome: env.remoteHome,
      hostPlatform: env.hostPlatform
    }
  }

  getPortScanner(): PortScanner | null {
    return this.portScanner
  }

  prepareForHostSleep(): void {
    const mux = this.mux
    if (!mux || mux.isDisposed() || this.isDisposed()) {
      return
    }
    // Why: sleep widens the grace so live remote PTYs outlast it, but stays
    // bounded — a sleep never followed by a reconnect used to leave the relay
    // and every shell it owns with no expiry at all. An explicit 0 is the
    // user's own choice and is left alone.
    mux.notify(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds:
        this.configuredGraceSeconds === 0 ? 0 : HOST_SLEEP_SSH_RELAY_GRACE_PERIOD_SECONDS
    })
  }

  /** Target removal is destructive: stop every remote shell and then the relay
   *  daemon itself. Best-effort — an unreachable host must never block removal,
   *  and a relay we cannot reach expires on its grace period instead. */
  async shutdownRemoteRelay(): Promise<void> {
    await this.terminateRemotePtys()
    const conn = this.currentConnection
    if (!conn) {
      return
    }
    const hostPlatform = this.getHostPlatform()
    if (hostPlatform && isWindowsRemoteHost(hostPlatform)) {
      // Why: forceStopRelayForTarget is a POSIX script; the PTY kills above already
      // freed the user's shells, so let a Windows relay expire on its grace period.
      return
    }
    try {
      await forceStopRelayForTarget(conn, this.targetId)
    } catch (err) {
      console.warn(
        `[ssh-relay-session] Failed to stop relay for removed target ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private async terminateRemotePtys(): Promise<void> {
    const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
    if (!ptyProvider || !this.mux || this.mux.isDisposed()) {
      return
    }
    const relayPtyIds = new Set([
      ...getPtyIdsForConnection(this.targetId).map((ptyId) =>
        toRelaySshPtyId(this.targetId, ptyId)
      ),
      ...this.store
        .getSshRemotePtyLeases(this.targetId)
        .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
        .map((lease) => lease.ptyId)
    ])
    const results = await Promise.allSettled(
      [...relayPtyIds].map((relayPtyId) =>
        // Why: immediate resolves only after physical exit, so the SIGKILL of every
        // process group on the tty is proven before the relay itself goes away.
        ptyProvider.shutdown(toAppSshPtyId(this.targetId, relayPtyId), {
          immediate: true,
          keepHistory: false
        })
      )
    )
    for (const result of results) {
      if (result.status === 'rejected' && !isSshPtyNotFoundError(result.reason)) {
        console.warn(
          `[ssh-relay-session] Failed to terminate a remote PTY for ${this.targetId}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`
        )
      }
    }
  }

  // Why: single entry point for relay setup (initial connect + app-restart reconnect) so no path forgets a registration step.
  async establish(conn: SshConnection, graceTimeSeconds?: number): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`Cannot establish relay session in state: ${this._state}`)
    }
    this._state = 'deploying'
    this.currentConnection = conn

    try {
      const {
        transport,
        remoteHome,
        remoteRelayDir,
        nodePath,
        sockPath,
        cliAuthToken,
        hostPlatform
      } = await deployAndLaunchRelay(conn, undefined, graceTimeSeconds, this.targetId)
      this.hostPlatform = hostPlatform ?? null
      // Why: without the CLI credential a pane's `orca` shim cannot authenticate, so
      // leave the bridge env unset rather than seeding a shim that always fails.
      this.remoteCliBridgeEnv =
        remoteHome && remoteRelayDir && nodePath && sockPath && cliAuthToken && hostPlatform
          ? {
              remoteHome,
              binDir: joinRemotePath(hostPlatform, remoteHome, '.orca-relay', 'bin'),
              relayDir: remoteRelayDir,
              nodePath,
              sockPath,
              cliAuthToken,
              hostPlatform,
              pathDelimiter: hostPlatform.pathDelimiter
            }
          : null

      // Why: dispose() can fire during the await above; if it did, creating a mux/providers now would leak with no owner to dispose them.
      if (this.isDisposed()) {
        const orphanMux = new SshChannelMultiplexer(transport)
        orphanMux.dispose()
        throw new Error('Session disposed during establish')
      }

      const mux = new SshChannelMultiplexer(transport)
      this.mux = mux
      const ownsAttempt = (): boolean => this.mux === mux && !this.isDisposed()

      // Why: round-trip the relay before registering providers so a closed --connect bridge fails fast instead of leaving a 'ready' session on a dead mux.
      await mux.request('session.resolveHome', { path: '~' })

      const registered = await this.registerProviders(mux, ownsAttempt)
      if (!registered) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        throw new Error('Session disposed during establish')
      }

      // Why: registerProviders swallows mux errors, so an isDisposed check catches a transport that closed mid-registration before we reach 'ready'.
      if (mux.isDisposed()) {
        throw new Error('Relay connection lost during provider registration')
      }

      if (this.isDisposed()) {
        this.teardownProviders('connection_lost')
        throw new Error('Session disposed during establish')
      }

      // Why: explicit disconnect keeps PTY ownership, so a later manual connect must reattach those remote PTYs.
      await this.reattachKnownPtys(ownsAttempt)

      if (!ownsAttempt()) {
        throw new Error('Session disposed during establish')
      }

      await this.reapPendingRemoteKills(ownsAttempt)

      this.configureRelayGraceTime(mux, graceTimeSeconds)
      this.watchMuxForRelayLoss(mux)
      this._state = 'ready'
      this.startPortScanning()
      this._onReady?.(this.targetId)
    } catch (err) {
      // Why: registerProviders can throw with a live mux and partial registration — tear everything down so a retry starts clean.
      if (!this.isDisposed()) {
        this.teardownProviders('connection_lost')
        this._state = 'idle'
      }
      // Why: a version mismatch on first connect is terminal (deployed binary vs. a still-running legacy daemon); notify the callback but still rethrow.
      if (isRelayVersionMismatchError(err)) {
        console.warn(
          `[ssh-relay-session] Terminal relay version mismatch on initial connect for ${this.targetId}: ${err.message}`
        )
        this._onTerminalRelayError?.(this.targetId, err)
      }
      throw err
    }
  }

  // Why: network-blip reconnect; AbortController-guarded so overlapping attempts from fast flaps cancel the stale one.
  async reconnect(conn: SshConnection, graceTimeSeconds?: number): Promise<void> {
    // Why: reconnect only from 'ready'/'reconnecting' — from 'deploying' it would tear down a mux establish() is still using; 'idle' has no session yet.
    if (this._state !== 'ready' && this._state !== 'reconnecting') {
      return
    }

    // Why: drop the relay-loss watcher before any teardown mux write, so a teardown-time
    // connection_lost can't re-enter recovery as a spurious relay loss (see releaseRelayLossWatcher).
    this.releaseRelayLossWatcher()
    // Cancel any in-flight reconnect
    this.abortController?.abort()
    const abortController = new AbortController()
    this.abortController = abortController

    this._state = 'reconnecting'
    this.currentConnection = conn

    // Why: stop scanning before teardownProviders so the poll timer can't fire against a disposed multiplexer.
    this.stopPortScanning()
    await this.portForwardManager.removeAllForwards(this.targetId)
    this.broadcastEmptyLists()
    this.teardownProviders('connection_lost')

    try {
      const {
        transport,
        remoteHome,
        remoteRelayDir,
        nodePath,
        sockPath,
        cliAuthToken,
        hostPlatform
      } = await deployAndLaunchRelay(conn, undefined, graceTimeSeconds, this.targetId)
      this.hostPlatform = hostPlatform ?? null
      // Why: without the CLI credential a pane's `orca` shim cannot authenticate, so
      // leave the bridge env unset rather than seeding a shim that always fails.
      this.remoteCliBridgeEnv =
        remoteHome && remoteRelayDir && nodePath && sockPath && cliAuthToken && hostPlatform
          ? {
              remoteHome,
              binDir: joinRemotePath(hostPlatform, remoteHome, '.orca-relay', 'bin'),
              relayDir: remoteRelayDir,
              nodePath,
              sockPath,
              cliAuthToken,
              hostPlatform,
              pathDelimiter: hostPlatform.pathDelimiter
            }
          : null

      if (abortController.signal.aborted || this.isDisposed()) {
        // Why: relay is already running remotely — a throwaway mux we immediately dispose sends a clean shutdown so it doesn't linger until grace expires.
        const orphanMux = new SshChannelMultiplexer(transport)
        orphanMux.dispose()
        return
      }

      const mux = new SshChannelMultiplexer(transport)
      this.mux = mux

      const ownsAttempt = (): boolean =>
        this.abortController === abortController &&
        !abortController.signal.aborted &&
        !this.isDisposed()

      // Why: same health check as establish() — round-trip the relay before registering providers so a dead --connect bridge fails fast.
      await mux.request('session.resolveHome', { path: '~' })
      if (!ownsAttempt()) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      const registered = await this.registerProviders(mux, ownsAttempt)
      if (!registered) {
        if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      if (mux.isDisposed()) {
        throw new Error('Relay connection lost during provider registration')
      }

      // Why: dispose() during registration/attach already cleaned up, but this.mux was reassigned above — clean up the new mux so it doesn't leak.
      if (!ownsAttempt()) {
        if (this.mux === mux) {
          this.teardownProviders('shutdown')
        } else if (!mux.isDisposed()) {
          mux.dispose()
        }
        return
      }

      await this.reattachKnownPtys(ownsAttempt)

      if (!ownsAttempt()) {
        return
      }

      await this.reapPendingRemoteKills(ownsAttempt)

      this.configureRelayGraceTime(mux, graceTimeSeconds)
      this.watchMuxForRelayLoss(mux)
      this._state = 'ready'
      this.startPortScanning()
      this._onReady?.(this.targetId)
    } catch (err) {
      // Why: tear down a partially-registered mux so its keepalive/timeout timers don't keep running on a half-initialized session.
      if (this.abortController === abortController && !this.isDisposed()) {
        this.teardownProviders('connection_lost')
      }
      // Why: version-mismatch is terminal — fire the typed callback and drop out of 'reconnecting' since backoff retry can't reconcile it.
      if (isRelayVersionMismatchError(err)) {
        console.warn(
          `[ssh-relay-session] Terminal relay version mismatch for ${this.targetId}: ${err.message}`
        )
        if (this.abortController === abortController && !this.isDisposed()) {
          this._state = 'idle'
        }
        this._onTerminalRelayError?.(this.targetId, err)
        return
      }
      // Why: stay in 'reconnecting' (not 'ready') since the provider stack is torn down; the SSH manager will fire another onStateChange to retry.
      console.warn(
        `[ssh-relay-session] Failed to re-establish relay for ${this.targetId}: ${err instanceof Error ? err.message : String(err)}`
      )
      if (this.abortController === abortController && !this.isDisposed()) {
        // Why: treat non-not-found attach failures as relay loss so ssh.ts's bounded backoff retries instead of stranding the session in 'reconnecting'.
        this._onRelayLost?.(this.targetId)
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null
      }
    }
  }

  dispose(): void {
    if (this._state === 'disposed') {
      return
    }
    this.releaseRelayLossWatcher()
    this.abortController?.abort()
    this.stopPortScanning()
    // Why: fire-and-forget — nothing rebinds after dispose, so no need to await port release.
    void this.portForwardManager.removeAllForwards(this.targetId)
    this.broadcastEmptyLists()
    this.teardownProviders('shutdown')
    this.store.markSshRemotePtyLeases(this.targetId, 'terminated')
    this.currentConnection = null
    this._state = 'disposed'
  }

  detach(): void {
    if (this._state === 'disposed') {
      return
    }
    this.releaseRelayLossWatcher()
    this.abortController?.abort()
    this.stopPortScanning()
    this.broadcastEmptyLists()
    // Why: window disconnect is non-destructive — unregister local providers but keep PTY ownership so reattach works (relay owns the grace timer).
    this.teardownProviders('connection_lost')
    this.store.markSshRemotePtyLeases(this.targetId, 'detached')
    this.currentConnection = null
    this._state = 'disposed'
  }

  // ── Private ───────────────────────────────────────────────────────

  // Why: teardown itself can kill the mux — a saturated control lane turns a teardown write into
  // mux.dispose('connection_lost'), and if the watcher is still live our own shutdown re-enters
  // recovery as a spurious relay loss. Every teardown path must release it before its first mux
  // write; teardownProviders is not early enough since stopPortScanning runs ahead of it. Release
  // ahead of abortController.abort() too: that signal reaches no mux request today, but plumbing it
  // into one would otherwise reopen the same hole silently.
  private releaseRelayLossWatcher(): void {
    this.muxDisposeCleanup?.()
    this.muxDisposeCleanup = null
  }

  // Why: onStateChange only fires on SSH-level reconnects, so watch for relay-channel loss while SSH stays up and fire onRelayLost.
  private watchMuxForRelayLoss(mux: SshChannelMultiplexer): void {
    this.releaseRelayLossWatcher()
    this.muxDisposeCleanup = mux.onDispose((reason) => {
      if (reason === 'connection_lost' && this.mux === mux && !this.isDisposed()) {
        console.warn(
          `[ssh-relay-session] Relay channel lost for ${this.targetId}, triggering reconnect`
        )
        this._onRelayLost?.(this.targetId)
      }
    })
  }

  // Why: shared by establish() and reconnect() so both use the exact same registration sequence.
  private async registerProviders(
    mux: SshChannelMultiplexer,
    shouldContinue?: () => boolean
  ): Promise<boolean> {
    await this.registerRelayRoots(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    await this.installManagedHooksOnRemote(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    await this.installPluginsOnRelay(mux)
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    try {
      await this.installRemoteOrcaCliLauncher()
    } catch (error) {
      // Why: on MaxSessions=1 remotes the relay holds the only slot, so this raw-connection install can fail — don't fail the whole connection.
      console.warn(
        `[ssh-relay-session] remote orca CLI launcher install failed for ${this.targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    if (shouldContinue && !shouldContinue()) {
      return false
    }

    this.wireUpRemoteOrcaCli(mux)

    const ptyProvider = new SshPtyProvider(this.targetId, mux, this.remoteCliBridgeEnv ?? undefined)
    registerSshPtyProvider(this.targetId, ptyProvider)

    const connection = this.requireReadyConnection()
    const createSftp =
      connection.usesSystemSshTransport?.() === true
        ? undefined
        : (options?: { signal?: AbortSignal }) => this.requireReadyConnection().sftp(options)
    // Why: getHostPlatform() falls back to this.hostPlatform when bridge env is incomplete, so path rules still match the host.
    const hostPlatform = this.getHostPlatform() ?? undefined
    const fsProvider = new SshFilesystemProvider(
      this.targetId,
      mux,
      createSftp,
      {
        downloadFile: (sourcePath, destinationPath) =>
          this.requireReadyConnection().downloadFile(sourcePath, destinationPath, {
            hostPlatform
          }),
        openFileUploadSession: () =>
          this.requireReadyConnection().openFileUploadSession({
            hostPlatform
          }),
        writeBuffer: (remotePath, contents, options) =>
          this.requireReadyConnection().writeBuffer(remotePath, contents, {
            hostPlatform,
            append: options.append,
            exclusive: options.exclusive
          })
      },
      hostPlatform
    )
    registerSshFilesystemProvider(this.targetId, fsProvider)

    const gitProvider = new SshGitProvider(
      this.targetId,
      mux,
      this.remoteCliBridgeEnv?.hostPlatform ?? null
    )
    registerSshGitProvider(this.targetId, gitProvider)

    this.wireUpPtyEvents(ptyProvider)
    this.wireUpAgentHookEvents(mux)
    this.wireUpRemoteWorkspaceEvents(mux)
    return true
  }

  private configureRelayGraceTime(
    mux: SshChannelMultiplexer,
    graceTimeSeconds: number | undefined
  ): void {
    this.configuredGraceSeconds = normalizeRelayGracePeriodSeconds(graceTimeSeconds)
    mux.notify(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: this.configuredGraceSeconds
    })
  }

  // Why: hook configs must exist before PTY spawn so first prompts report status; relay-local work keeps all managed installs to one SSH round trip.
  private async installManagedHooksOnRemote(mux: SshChannelMultiplexer): Promise<void> {
    if (!isRemoteAgentHooksEnabled() || !this.areAgentStatusHooksEnabled()) {
      return
    }
    if (
      this.remoteCliBridgeEnv?.hostPlatform &&
      isWindowsRemoteHost(this.remoteCliBridgeEnv.hostPlatform)
    ) {
      // Why: managed hook installers emit POSIX-only scripts/paths; Windows remotes rely on relay-injected env + plugin overlays instead.
      return
    }

    try {
      const hostKeyFingerprint = this.requireReadyConnection().getHostKeyFingerprint?.()
      const params = hostKeyFingerprint ? { hostKeyFingerprint } : {}
      const result = (await mux.request(AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD, params)) as {
        errors?: unknown
      }
      if (typeof result.errors === 'number' && result.errors > 0) {
        console.warn(
          `[ssh-relay-session] ${result.errors} remote managed hook installers failed for ${this.targetId}`
        )
      }
    } catch (error) {
      // Why: teardown routinely cancels this best-effort request; only warn for
      // installer failures that survive the connection lifecycle.
      const code = (error as { code?: unknown })?.code
      if (
        code === -32601 ||
        code === 'CONNECTION_LOST' ||
        code === 'DISPOSED' ||
        mux.isDisposed()
      ) {
        return
      }
      console.warn(
        `[ssh-relay-session] relay managed hook install failed for ${this.targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  private async installRemoteOrcaCliLauncher(): Promise<void> {
    if (!this.remoteCliBridgeEnv) {
      return
    }
    const { binDir, hostPlatform } = this.remoteCliBridgeEnv
    const plan = createRemoteCliInstallPlan(this.remoteCliBridgeEnv)
    const conn = this.requireReadyConnection()
    await execCommand(conn, makeRemoteDirectoryCommand(hostPlatform, binDir), {
      wrapCommand: !isWindowsRemoteHost(hostPlatform)
    })
    if (typeof conn.writeFile === 'function') {
      for (const file of plan.files) {
        await conn.writeFile(file.path, file.contents, { hostPlatform })
      }
    } else {
      const sftp = await conn.sftp()
      try {
        for (const file of plan.files) {
          await new Promise<void>((resolve, reject) => {
            const ws = sftp.createWriteStream(file.path)
            sftp.once('error', reject)
            ws.once('close', resolve)
            ws.once('error', reject)
            ws.end(file.contents)
          })
        }
      } finally {
        sftp.end()
      }
    }
    for (const command of plan.postWriteCommands) {
      await execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(hostPlatform) })
    }
  }

  private wireUpRemoteOrcaCli(mux: SshChannelMultiplexer): void {
    mux.onRequest('orca.cli', async (params) => {
      if (!this.runtime) {
        throw new Error('Orca runtime is unavailable')
      }
      // Why: the owning target is session state, not payload — the remote account
      // can rewrite everything it sends, but not which connection it arrived on.
      return await runRemoteOrcaCli(this.runtime, {
        ...parseRemoteOrcaCliRequest(params),
        connectionId: this.targetId
      })
    })
  }

  // Why: ship plugin/extension source from Orca so agent-event changes don't force a relay redeploy — the relay is versioned independently. Best-effort: failure only costs agent status on this host.
  private async installPluginsOnRelay(mux: SshChannelMultiplexer): Promise<void> {
    if (!isRemoteAgentHooksEnabled() || !this.areAgentStatusHooksEnabled()) {
      return
    }
    try {
      await mux.request(AGENT_HOOK_INSTALL_PLUGINS_METHOD, {
        opencodePluginSource: openCodeInternals.getOpenCodePluginSource(),
        piExtensionSource: getPiAgentStatusExtensionSource('pi'),
        ompExtensionSource: getPiAgentStatusExtensionSource('omp')
      })
    } catch (err) {
      // Why: -32601 = older relay without the handler; CONNECTION_LOST/DISPOSED = routine mid-flight teardown — swallow both.
      const code = (err as { code?: unknown })?.code
      if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED') {
        return
      }
      if (mux.isDisposed()) {
        return
      }
      console.warn(
        `[ssh-relay-session] agent_hook.installPlugins failed for ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private areAgentStatusHooksEnabled(): boolean {
    const store = this.store as { getSettings?: Store['getSettings'] }
    return isAgentStatusHooksEnabled(store.getSettings?.())
  }

  private wireUpRemoteWorkspaceEvents(mux: SshChannelMultiplexer): void {
    mux.onNotification((method, params) => {
      notifyRemoteWorkspaceHandlers(this.targetId, method, params)
    })
  }

  // Why: relay sends connectionId:null, so stamp this.targetId here so the renderer can drop events from torn-down connections.
  private wireUpAgentHookEvents(mux: SshChannelMultiplexer): void {
    if (!isRemoteAgentHooksEnabled()) {
      return
    }
    // Why: capture the disposer so teardownProviders can release this handler and re-wiring can't double-register it.
    this.muxNotificationCleanup?.()
    this.muxNotificationCleanup = mux.onNotification((method, params) => {
      if (method !== AGENT_HOOK_NOTIFICATION_METHOD) {
        return
      }
      const envelope = params as {
        paneKey?: unknown
        launchToken?: unknown
        tabId?: unknown
        worktreeId?: unknown
        env?: unknown
        version?: unknown
        hasExplicitPrompt?: unknown
        promptInteractionKey?: unknown
        hookEventName?: unknown
        source?: unknown
        providerPromptId?: unknown
        compactTrigger?: unknown
        toolUseId?: unknown
        toolAgentId?: unknown
        toolAgentType?: unknown
        isReplay?: unknown
        providerSession?: unknown
        providerSessionOnly?: unknown
        payload?: unknown
      }
      if (typeof envelope.paneKey !== 'string') {
        return
      }
      // Why: forward the agent CLI's env/version verbatim (not the relay's) so warn-once protocol-mismatch diagnostics fire for remote events too.
      agentHookServer.ingestRemote(
        {
          paneKey: envelope.paneKey,
          launchToken: typeof envelope.launchToken === 'string' ? envelope.launchToken : undefined,
          tabId: typeof envelope.tabId === 'string' ? envelope.tabId : undefined,
          worktreeId: typeof envelope.worktreeId === 'string' ? envelope.worktreeId : undefined,
          env: typeof envelope.env === 'string' ? envelope.env : undefined,
          version: typeof envelope.version === 'string' ? envelope.version : undefined,
          hasExplicitPrompt: envelope.hasExplicitPrompt === true ? true : undefined,
          promptInteractionKey:
            typeof envelope.promptInteractionKey === 'string'
              ? envelope.promptInteractionKey
              : undefined,
          hookEventName:
            typeof envelope.hookEventName === 'string' ? envelope.hookEventName : undefined,
          source: envelope.source,
          providerPromptId: envelope.providerPromptId,
          compactTrigger: envelope.compactTrigger,
          toolUseId: typeof envelope.toolUseId === 'string' ? envelope.toolUseId : undefined,
          toolAgentId: typeof envelope.toolAgentId === 'string' ? envelope.toolAgentId : undefined,
          toolAgentType:
            typeof envelope.toolAgentType === 'string' ? envelope.toolAgentType : undefined,
          isReplay: envelope.isReplay === true ? true : undefined,
          providerSession: envelope.providerSession,
          providerSessionOnly: envelope.providerSessionOnly === true ? true : undefined,
          payload: envelope.payload
        },
        this.targetId
      )
    })

    // Why: request replay of cached paneKeys only after the handler is wired, so replayed events can't arrive before we subscribe. Best-effort.
    void mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD).catch((err) => {
      const code = (err as { code?: unknown })?.code
      if (code === -32601 || code === 'CONNECTION_LOST' || code === 'DISPOSED') {
        return
      }
      if (mux.isDisposed()) {
        return
      }
      // Why: suppress the warn when a normal teardown rejects the in-flight request, so reconnect cycles aren't noisy.
      if (mux.isDisposed()) {
        return
      }
      console.warn(
        `[ssh-relay-session] agent_hook.requestReplay failed for ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    })
  }

  private teardownProviders(reason: 'shutdown' | 'connection_lost'): void {
    this.releaseRelayLossWatcher()
    this.muxNotificationCleanup?.()
    this.muxNotificationCleanup = null
    if (this.mux && !this.mux.isDisposed()) {
      this.mux.dispose(reason)
    }
    this.mux = null

    if (reason === 'shutdown') {
      clearPtyOwnershipForConnection(this.targetId)
    } else {
      // Why: handlers detached above, so no late event can re-stamp status between this clear and reconnect replay.
      agentHookServer.clearStatusEntriesForConnection(this.targetId)
    }

    const ptyProvider = getSshPtyProvider(this.targetId)
    if (ptyProvider && 'dispose' in ptyProvider) {
      ;(ptyProvider as { dispose: () => void }).dispose()
    }
    const fsProvider = getSshFilesystemProvider(this.targetId)
    if (fsProvider && 'dispose' in fsProvider) {
      ;(fsProvider as { dispose: () => void }).dispose()
    }

    unregisterSshPtyProvider(this.targetId)
    unregisterSshFilesystemProvider(this.targetId)
    unregisterSshGitProvider(this.targetId)
  }

  // Why: back-compat for old relays that gate FS ops on registered roots; removable post-cutover (docs/relay-fs-allowlist-removal.md).
  private async registerRelayRoots(mux: SshChannelMultiplexer): Promise<void> {
    const remoteRepos = this.store.getRepos().filter((r) => r.connectionId === this.targetId)

    for (const repo of remoteRepos) {
      mux.notify('session.registerRoot', { rootPath: repo.path })
    }

    // Why: git.listWorktrees requires the repo root to be registered first.
    await Promise.all(
      remoteRepos.map(async (repo) => {
        try {
          const worktrees = (await mux.request('git.listWorktrees', {
            repoPath: repo.path
          })) as { path: string }[]
          for (const wt of worktrees) {
            if (wt.path !== repo.path) {
              mux.notify('session.registerRoot', { rootPath: wt.path })
            }
          }
        } catch {
          // git worktree list may fail for folder-mode repos — not fatal
        }
      })
    )
  }

  // Why: shared by establish()/reconnect() so both paths reset renderer lists the same way.
  private broadcastEmptyLists(): void {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    win.webContents.send('ssh:port-forwards-changed', {
      targetId: this.targetId,
      forwards: []
    })
    win.webContents.send('ssh:detected-ports-changed', {
      targetId: this.targetId,
      ports: []
    })
  }

  private startPortScanning(): void {
    if (!this.mux || this.isDisposed()) {
      return
    }
    // Why: each scan walks /proc/*/fd remotely, so skip ticks while the window is hidden and rescan when it returns.
    const scanner = new PortScanner({
      isWindowVisible: () => isMainWindowVisible(this.getMainWindow()),
      onWindowBecameVisible: onMainWindowBecameVisible
    })
    this.portScanner = scanner
    // Why: guard against a late ports.detect callback from a pre-reconnect scanner publishing stale results into the new session.
    scanner.startScanning(this.targetId, this.mux, (targetId, ports, platform) => {
      if (this.portScanner !== scanner) {
        return
      }
      this.onDetectedPortsChanged?.(targetId, ports, platform)
    })
  }

  private stopPortScanning(): void {
    if (this.portScanner) {
      this.portScanner.stopScanning(this.targetId)
      this.portScanner = null
    }
  }

  private wireUpPtyEvents(ptyProvider: SshPtyProvider): void {
    ptyProvider.onData((payload) => {
      const rawLength = payload.sequenceChars ?? payload.data.length
      const seq = this.runtime?.onPtyData(
        payload.id,
        payload.data,
        Date.now(),
        rawLength,
        payload.transformed
      )
      const win = this.getMainWindow()
      if (!win || win.isDestroyed()) {
        return
      }
      // Why: hidden-delivery gate parity with ipc/pty.ts — latch model-restore out-of-band, never an in-band pty:data sentinel (OSC-9999-only chunks strip to empty).
      const store = this.store as { getSettings?: Store['getSettings'] }
      if (shouldDropHiddenRendererPtyData(payload.id, store.getSettings?.())) {
        const drop = recordHiddenRendererPtyDataDrop(payload.id, rawLength)
        if (drop.shouldEmitRestoreMarker) {
          win.webContents.send('pty:modelRestoreNeeded', {
            id: payload.id,
            reason: 'hidden-drop',
            ...(typeof seq === 'number' ? { markerSeq: seq } : {})
          } satisfies PtyModelRestoreNeededEvent)
        }
        return
      }
      if (payload.data.length > 0 || payload.transformed) {
        win.webContents.send('pty:data', {
          ...payload,
          ...(typeof seq === 'number' ? { seq } : {}),
          rawLength,
          ...(payload.transformed ? { transformed: true } : {})
        })
      }
    })
    ptyProvider.onReplay((payload) => {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:replay', payload)
      }
    })
    ptyProvider.onExit((payload) => {
      const pendingReattach = this.pendingPtyReattaches.get(payload.id)
      if (pendingReattach) {
        // Why: attach response and exit can share one transport batch, before incarnation restoration runs.
        pendingReattach.exits.push(payload)
        return
      }
      if (!isCurrentPtyExit(payload)) {
        return
      }
      this.retireExitedPty(payload)
    })
  }

  private retireExitedPty(payload: SshPtyExitPayload): void {
    const relayPtyId = toRelaySshPtyId(this.targetId, payload.id)
    clearProviderPtyState(payload.id)
    deletePtyOwnership(payload.id)
    this.forwardedReattachReplayByPty.delete(payload.id)
    this.store.markSshRemotePtyLease(this.targetId, relayPtyId, 'terminated')
    this.runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId)
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', payload)
    }
  }

  private replayFingerprint(data: string): string {
    const head = data.slice(0, REPLAY_FINGERPRINT_EDGE_CHARS)
    const tail = data.slice(-REPLAY_FINGERPRINT_EDGE_CHARS)
    return `${data.length}:${head}:${tail}`
  }

  private shouldForwardReattachReplay(appPtyId: string, data: string): boolean {
    const now = Date.now()
    const fingerprint = this.replayFingerprint(data)
    const previous = this.forwardedReattachReplayByPty.get(appPtyId)
    this.forwardedReattachReplayByPty.set(appPtyId, { fingerprint, deliveredAt: now })
    return (
      !previous ||
      previous.fingerprint !== fingerprint ||
      now - previous.deliveredAt > RECONNECT_REPLAY_DUPLICATE_WINDOW_MS
    )
  }

  private forwardReattachReplay(appPtyId: string, data: string): void {
    if (!data || !this.shouldForwardReattachReplay(appPtyId, data)) {
      return
    }
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:replay', { id: appPtyId, data })
    }
  }

  // Why: a pane closed while the relay was unreachable left its remote shell
  // running with no UI trace; reconcile those intents now that we have a relay.
  // Relay pty ids are a per-relay counter, so a restarted relay can hand `pty-N`
  // to somebody else's pane — kill only when the relay reports the exact
  // incarnation the lease recorded, and give up on the intent otherwise.
  private async reapPendingRemoteKills(shouldContinue: () => boolean): Promise<void> {
    const pending = this.store
      .getSshRemotePtyLeases(this.targetId)
      .filter((lease) => lease.killRequestedAt !== undefined)
    if (pending.length === 0) {
      return
    }
    const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
    if (!ptyProvider) {
      return
    }
    let incarnationByAppPtyId: Map<string, string | undefined>
    try {
      const live = await ptyProvider.listProcesses()
      incarnationByAppPtyId = new Map(live.map((session) => [session.id, session.incarnationId]))
    } catch (err) {
      // Why: keep every intent — an unanswered listing is not evidence the shell died.
      console.warn(
        `[ssh-relay-session] Could not list remote PTYs to reap closed panes for ${this.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return
    }
    for (const lease of pending) {
      if (!shouldContinue()) {
        return
      }
      const appPtyId = toAppSshPtyId(this.targetId, lease.ptyId)
      const liveIncarnation = incarnationByAppPtyId.get(appPtyId)
      if (liveIncarnation !== undefined) {
        if (lease.incarnationId === undefined || liveIncarnation !== lease.incarnationId) {
          console.warn(
            `[ssh-relay-session] Not reaping ${lease.ptyId} on ${this.targetId}: the relay reports a different PTY under that id`
          )
        } else {
          try {
            await ptyProvider.shutdown(appPtyId, { immediate: true, keepHistory: false })
          } catch (err) {
            if (!isSshPtyNotFoundError(err)) {
              // Why: keep the intent so the next connect retries the kill.
              console.warn(
                `[ssh-relay-session] Failed to reap closed pane ${lease.ptyId} on ${this.targetId}: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
              continue
            }
          }
        }
      }
      this.store.clearSshRemotePtyKillIntent(this.targetId, lease.ptyId)
    }
  }

  private async reattachKnownPtys(shouldContinue: () => boolean): Promise<void> {
    const activeLeases = this.store
      .getSshRemotePtyLeases(this.targetId)
      .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
    const activeLeaseByPtyId = new Map(activeLeases.map((lease) => [lease.ptyId, lease]))
    const leasedPtyIds = activeLeases.map((lease) => lease.ptyId)
    // Why: pass pane identity so the relay can reject cross-generation id collisions; tabId falls back for pre-leafId leases.
    const expectedIdentityByPtyId = new Map(
      activeLeases
        .map((lease): [string, ExpectedPtyIdentity] | null => {
          const expected = expectedIdentityForLease(lease)
          return expected ? [lease.ptyId, expected] : null
        })
        .filter((entry): entry is [string, ExpectedPtyIdentity] => entry !== null)
    )
    // Why: after app restart ptyOwnership is empty, but durable SSH leases still describe grace-window survivors.
    const ptyIds = Array.from(
      new Set([
        ...getPtyIdsForConnection(this.targetId).map((ptyId) =>
          toRelaySshPtyId(this.targetId, ptyId)
        ),
        ...leasedPtyIds
      ])
    )
    const ptyProvider = getSshPtyProvider(this.targetId) as SshPtyProvider | undefined
    if (!ptyProvider) {
      return
    }
    // Why (SSH reconnect perf): mark every reattached lease in memory and flush
    // once at the end. Per-lease flushes each did two full-state JSON.stringify
    // passes plus a blocking writeFileSync, stalling the main thread once per
    // open remote terminal on the routine wifi-flap / wake / relay-backoff
    // reconnect this reattach exists for. The finally flush persists whatever
    // was marked even when the loop returns early or rethrows, so the durable
    // outcome matches the old per-lease flushes exactly.
    let leaseChanged = false
    try {
      for (const ptyId of ptyIds) {
        if (!shouldContinue()) {
          return
        }
        const appPtyId = toAppSshPtyId(this.targetId, ptyId)
        const pendingReattach: PendingPtyReattach = { exits: [] }
        this.pendingPtyReattaches.set(appPtyId, pendingReattach)
        try {
          const expectedIdentity = expectedIdentityByPtyId.get(ptyId)
          const attachResult =
            (expectedIdentity
              ? await ptyProvider.attachForReconnect(ptyId, expectedIdentity)
              : await ptyProvider.attachForReconnect(ptyId)) ?? {}
          if (!shouldContinue()) {
            return
          }
          const exitDuringAttach = pendingReattach.exits.find(
            (exit) =>
              !exit.incarnationId ||
              !attachResult.incarnationId ||
              exit.incarnationId === attachResult.incarnationId
          )
          if (exitDuringAttach) {
            if (attachResult.incarnationId) {
              restorePtyIncarnation(appPtyId, attachResult.incarnationId)
              this.runtime?.acceptPtyIncarnationForExit(appPtyId, attachResult.incarnationId)
            }
            this.retireExitedPty(exitDuringAttach)
            continue
          }
          setPtyOwnership(appPtyId, this.targetId)
          if (attachResult.incarnationId) {
            restorePtyIncarnation(appPtyId, attachResult.incarnationId)
            const lease = activeLeaseByPtyId.get(ptyId)
            if (lease?.worktreeId && lease.tabId && lease.leafId) {
              this.runtime?.registerPty(appPtyId, lease.worktreeId, this.targetId, {
                tabId: lease.tabId,
                leafId: lease.leafId,
                incarnationId: attachResult.incarnationId
              })
              // Why: reconnect may be the first new-relay response that can backfill exact exit fencing.
              try {
                this.store.persistPtyBinding({
                  worktreeId: lease.worktreeId,
                  tabId: lease.tabId,
                  leafId: lease.leafId,
                  ptyId: appPtyId,
                  incarnationId: attachResult.incarnationId
                })
              } catch (error) {
                // Why: this backfill improves future fencing but must not disconnect an already-live relay PTY.
                console.error('[ssh-relay-session] Failed to persist reconnect incarnation:', error)
              }
            } else {
              this.runtime?.onPtySpawned(appPtyId, attachResult.incarnationId, {
                awaitsRegistration: false
              })
            }
          }
          if (
            this.store.markSshRemotePtyLease(this.targetId, ptyId, 'attached', {
              flush: false,
              // Why: backfills leases written before incarnations were stored, so a later
              // close-while-unreachable can still prove which process it may reap.
              ...(attachResult.incarnationId ? { incarnationId: attachResult.incarnationId } : {})
            })
          ) {
            leaseChanged = true
          }
          this.forwardReattachReplay(appPtyId, attachResult.replay ?? '')
        } catch (err) {
          if (!isSshPtyNotFoundError(err)) {
            throw err
          }
          if (isSshPtyIdentityMismatchError(err)) {
            console.warn(
              `[ssh-relay-session] Ignoring stale PTY ${ptyId} for ${this.targetId} after relay identity mismatch: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
            continue
          }
          console.warn(
            `[ssh-relay-session] Dropping stale PTY ${ptyId} for ${this.targetId} after relay reattach failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
          clearProviderPtyState(appPtyId)
          deletePtyOwnership(appPtyId)
          this.forwardedReattachReplayByPty.delete(appPtyId)
          if (this.store.markSshRemotePtyLease(this.targetId, ptyId, 'expired', { flush: false })) {
            leaseChanged = true
          }
          // Why: if the new relay cannot reattach this id, the remote backing
          // process is gone. Tell the renderer so it clears stale pane bindings
          // instead of keeping a cursor-only terminal.
          const win = this.getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('pty:exit', { id: appPtyId, code: -1 })
          }
        } finally {
          if (this.pendingPtyReattaches.get(appPtyId) === pendingReattach) {
            this.pendingPtyReattaches.delete(appPtyId)
          }
        }
      }
    } finally {
      if (leaseChanged) {
        this.store.flush()
      }
    }
  }
}
