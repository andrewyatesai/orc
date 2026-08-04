import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  discoverLegacySessionRoutes,
  reconcileSessionRoutesOnStartup,
  resolveInspectionAdapter,
  resolveSessionAdapter
} from './daemon-session-adapter-routing'
import { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'
import type {
  IPtyProvider,
  PtyBackgroundStreamEvent,
  PtyProviderBufferSnapshot,
  PtyProcessInfo,
  PtySessionLiveness,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import { probePtyOwners } from './daemon-pty-liveness-probe'
import { shouldHandoffDaemonHistory } from './daemon-history-handoff'
import type { DaemonPtyRouterDataEvent, DaemonPtyRouterExitEvent } from './daemon-pty-router-events'

export class DaemonPtyRouter implements IPtyProvider {
  private current: DaemonPtyAdapter
  private legacy: DaemonPtyAdapter[]
  private sessionAdapters = new Map<string, DaemonPtyAdapter>()
  private readonly subscriptions: DaemonPtyAdapterSubscriptionFanout

  constructor(opts: { current: DaemonPtyAdapter; legacy: DaemonPtyAdapter[] }) {
    this.current = opts.current
    this.legacy = opts.legacy
    this.subscriptions = new DaemonPtyAdapterSubscriptionFanout(this.allAdapters(), (id) => {
      this.sessionAdapters.delete(id)
    })
  }

  async discoverLegacySessions(): Promise<void> {
    await discoverLegacySessionRoutes(this.legacy, this.sessionAdapters)
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const adapter = opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined
    const target = adapter ?? this.current
    const result = await target.spawn(opts)
    // Why: the adapter filters intentional recovery exits and canonical-ID races before publishing proof.
    if (!result.exitedBeforeSpawnReply) {
      this.sessionAdapters.set(result.id, target)
    }
    return result
  }

  supportsGitCredentialGuardHost(sessionId?: string): boolean {
    const adapter = sessionId ? this.adapterFor(sessionId) : this.current
    return adapter.supportsGitCredentialGuardHost()
  }

  supportsAgentSessionClaims(): boolean {
    // Why: a legacy daemon may still own a resumable PTY, so authority requires every route.
    return this.allAdapters().every((adapter) => adapter.supportsAgentSessionClaims())
  }

  providesAgentSessionOwnerListings(ptyId: string): boolean {
    const adapter = this.sessionAdapters.get(ptyId)
    // Why: an unmapped id may belong to any preserved daemon generation;
    // only an established route can make an omitted owner authoritative.
    return adapter?.providesAgentSessionOwnerListings(ptyId) === true
  }

  supportsAgentSessionCreateOperations(): boolean {
    // Fresh sessions always route to the current daemon; legacy adapters only retain old IDs.
    return this.current.supportsAgentSessionCreateOperations()
  }

  async attach(id: string): Promise<void> {
    await this.adapterFor(id).attach(id)
  }

  hasPty(id: string): boolean {
    const routed = this.sessionAdapters.get(id)
    if (routed) {
      return routed.hasPty(id)
    }
    return this.current.hasPty(id) || this.legacy.some((adapter) => adapter.hasPty(id))
  }

  async probePtyLiveness(id: string): Promise<boolean | null> {
    return await probePtyOwners(id, this.sessionAdapters.get(id), this.allAdapters())
  }

  write(id: string, data: string): void {
    this.adapterFor(id).write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.adapterFor(id).resize(id, cols, rows)
  }

  pauseProducer(id: string): void {
    this.adapterFor(id).pauseProducer(id)
  }

  resumeProducer(id: string): void {
    this.adapterFor(id).resumeProducer(id)
  }

  setPtyBackgrounded(id: string, background: boolean): void {
    this.adapterFor(id).setPtyBackgrounded(id, background)
  }

  async shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<void> {
    const adapter = this.adapterFor(id)
    const migrateHistory = shouldHandoffDaemonHistory(opts.keepHistory, adapter, this.current)
    try {
      await adapter.shutdown(id, opts)
    } catch (error) {
      if (adapter === this.current || !isMissingLegacyDaemonEndpointError(error)) {
        throw error
      }
      console.warn('[daemon] Legacy daemon endpoint disappeared during session shutdown', error)
      this.sessionAdapters.delete(id)
      return
    }
    // Why: sleep passes keepHistory=true and re-spawns on the same sessionId, so the legacy route must
    // survive or wake lands on `current` and loses that adapter's cold-restore — unless history migrates.
    if (!opts.keepHistory || migrateHistory) {
      if (migrateHistory) {
        adapter.ackColdRestore(id)
      }
      if (this.sessionAdapters.get(id) === adapter) {
        this.sessionAdapters.delete(id)
      }
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.adapterFor(id).sendSignal(id, signal)
  }

  async getCwd(id: string): Promise<string> {
    return this.adapterFor(id).getCwd(id)
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.adapterFor(id).getInitialCwd(id)
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return (await this.adapterFor(id).getAppliedSize?.(id)) ?? null
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    return await this.adapterFor(id).getBufferSnapshot(id, opts)
  }

  canProvideAuthoritativeBufferSnapshot(id: string): boolean {
    return this.adapterFor(id).canProvideAuthoritativeBufferSnapshot(id)
  }

  async clearBuffer(id: string): Promise<void> {
    await this.adapterFor(id).clearBuffer(id)
  }

  async closeStartupQueryAuthority(id: string): Promise<number> {
    return (await this.adapterFor(id).closeStartupQueryAuthority?.(id)) ?? 0
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.adapterFor(id).acknowledgeDataEvent(id, charCount)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    return this.adapterFor(id).hasChildProcesses(id)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    return this.adapterFor(id).getForegroundProcess(id)
  }

  async inspectProcess(id: string): Promise<PtyProcessInspection> {
    return this.adapterForInspection(id).inspectProcess(id)
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    return this.adapterFor(id).confirmForegroundProcess(id)
  }

  async serialize(ids: string[]): Promise<string> {
    return this.current.serialize(ids)
  }

  async revive(state: string): Promise<void> {
    await this.current.revive(state)
  }

  async getSessionLiveness(id: string): Promise<PtySessionLiveness | null> {
    // Why: adapterFor self-heals routing by asking who owns the pty, so death evidence comes from the daemon that actually hosts it.
    return await this.adapterFor(id).getSessionLiveness(id)
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    // Why: runtime exact-stop/liveness flows fail closed for the current daemon
    // and live legacy daemons. A legacy endpoint whose socket/token disappeared
    // cannot own a live session, so treating ENOENT as an empty inventory lets
    // destructive worktree teardown proceed after an upgrade.
    const results = await Promise.all([
      this.current.listProcesses(opts),
      ...this.legacy.map(async (adapter) => {
        try {
          return await adapter.listProcesses(opts)
        } catch (error) {
          if (!isMissingLegacyDaemonEndpointError(error)) {
            throw error
          }
          console.warn(
            '[daemon] Legacy daemon endpoint disappeared during session inventory',
            error
          )
          return []
        }
      })
    ])
    return results.flat()
  }

  async getDefaultShell(): Promise<string> {
    return this.current.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return this.current.getProfiles()
  }

  onData(callback: (payload: DaemonPtyRouterDataEvent) => void): () => void {
    return this.subscriptions.onData(callback)
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    return this.subscriptions.onBackgroundStreamEvent(callback)
  }

  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    return this.subscriptions.onWriteUnavailable(callback)
  }

  onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
    return this.subscriptions.onReplay(callback)
  }

  onExit(callback: (payload: DaemonPtyRouterExitEvent) => void): () => void {
    return this.subscriptions.onExit(callback)
  }

  ackColdRestore(sessionId: string): void {
    this.adapterFor(sessionId).ackColdRestore(sessionId)
  }

  clearTombstone(sessionId: string): void {
    this.adapterFor(sessionId).clearTombstone(sessionId)
  }

  async reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
    alive: string[]
    killed: string[]
  }> {
    return reconcileSessionRoutesOnStartup(
      this.allAdapters(),
      this.sessionAdapters,
      validWorktreeIds
    )
  }

  dispose(): void {
    this.subscriptions.dispose()
    for (const adapter of this.allAdapters()) {
      adapter.dispose()
    }
  }

  // Why: restart swaps to a fresh router carrying the *same* legacy adapter
  // instances. If we called dispose() on the outgoing router it would tear
  // down those legacy adapters along with it. disposeRouterOnly() detaches
  // only this router's subscriptions from the adapters — the adapters and
  // their daemon connections keep running, and the new router re-subscribes.
  // Without this, each restart leaked a router instance pinned by the legacy
  // adapters' listener arrays (one pair per adapter per restart).
  disposeRouterOnly(): void {
    this.subscriptions.dispose()
  }

  async disconnectOnly(): Promise<void> {
    this.subscriptions.dispose()
    await Promise.all([...this.allAdapters()].map((adapter) => adapter.disconnectOnly()))
  }

  // Why: the Manage Sessions panel iterates all adapters to list sessions
  // across every protocol version, and the restart handler needs to preserve
  // surviving legacy adapters across the current-adapter swap. On this branch
  // (pre-#1323) the legacy list is set once at construction and never mutated,
  // so returning the internal array by reference is safe for the intended
  // read-only use.
  getCurrentAdapter(): DaemonPtyAdapter {
    return this.current
  }

  getLegacyAdapters(): readonly DaemonPtyAdapter[] {
    return this.legacy
  }

  getAllAdapters(): readonly DaemonPtyAdapter[] {
    return this.allAdapters()
  }

  private adapterFor(sessionId: string): DaemonPtyAdapter {
    return resolveSessionAdapter(sessionId, this.sessionAdapters, this.current, this.legacy)
  }

  private adapterForInspection(sessionId: string): DaemonPtyAdapter {
    return resolveInspectionAdapter(sessionId, this.sessionAdapters, this.current, this.legacy)
  }

  private allAdapters(): DaemonPtyAdapter[] {
    return [this.current, ...this.legacy]
  }
}

function isMissingLegacyDaemonEndpointError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT' &&
    ((error as NodeJS.ErrnoException).syscall === 'connect' ||
      (error as NodeJS.ErrnoException).syscall === 'open')
  )
}
