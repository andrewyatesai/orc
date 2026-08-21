import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import {
  SubscriberDrivenDaemonAttach,
  type SubscriberDrivenDaemonAttachDeps
} from './subscriber-driven-daemon-attach'

type LiveRouting = { connectionId: string | null; connected: boolean }

function makeCoordinator(overrides: Partial<SubscriberDrivenDaemonAttachDeps> = {}): {
  coordinator: SubscriberDrivenDaemonAttach
  attach: ReturnType<typeof vi.fn>
  routing: Map<string, LiveRouting>
  headless: Set<string>
  snapshotPreferred: Set<string>
  registrationPending: Set<string>
} {
  const attach = vi.fn(async () => true)
  const routing = new Map<string, LiveRouting>()
  const headless = new Set<string>()
  const snapshotPreferred = new Set<string>()
  const registrationPending = new Set<string>()
  const deps: SubscriberDrivenDaemonAttachDeps = {
    getAttach: () => attach,
    hasHeadlessState: (ptyId) => headless.has(ptyId),
    isProviderSnapshotPreferred: (ptyId) => snapshotPreferred.has(ptyId),
    isRegistrationPending: (ptyId) => registrationPending.has(ptyId),
    getLocalPtyRouting: (ptyId) => routing.get(ptyId),
    ...overrides
  }
  return {
    coordinator: new SubscriberDrivenDaemonAttach(deps),
    attach,
    routing,
    headless,
    snapshotPreferred,
    registrationPending
  }
}

const LIVE_LOCAL: LiveRouting = { connectionId: null, connected: true }

describe('SubscriberDrivenDaemonAttach.isKnownUnattachedLocalDaemonPty', () => {
  it('is true for a live local session with no ingested bytes and no local spawn', () => {
    const { coordinator, routing } = makeCoordinator()
    routing.set('pty', LIVE_LOCAL)
    expect(coordinator.isKnownUnattachedLocalDaemonPty('pty')).toBe(true)
  })

  it('is false for an unknown session', () => {
    const { coordinator } = makeCoordinator()
    expect(coordinator.isKnownUnattachedLocalDaemonPty('unknown')).toBe(false)
  })

  it('is false once bytes are ingested (headless state exists)', () => {
    const { coordinator, routing, headless } = makeCoordinator()
    routing.set('pty', LIVE_LOCAL)
    headless.add('pty')
    expect(coordinator.isKnownUnattachedLocalDaemonPty('pty')).toBe(false)
  })

  it('is false while a provider snapshot reconcile is in flight', () => {
    const { coordinator, routing, snapshotPreferred } = makeCoordinator()
    routing.set('pty', LIVE_LOCAL)
    snapshotPreferred.add('pty')
    expect(coordinator.isKnownUnattachedLocalDaemonPty('pty')).toBe(false)
  })

  it('is false for a session a local spawn published this generation', () => {
    const { coordinator, routing } = makeCoordinator()
    routing.set('pty', LIVE_LOCAL)
    coordinator.markSpawnPublished('pty')
    expect(coordinator.isKnownUnattachedLocalDaemonPty('pty')).toBe(false)
  })

  it('is false while a spawn registration is pending', () => {
    const { coordinator, routing, registrationPending } = makeCoordinator()
    routing.set('pty', LIVE_LOCAL)
    registrationPending.add('pty')
    expect(coordinator.isKnownUnattachedLocalDaemonPty('pty')).toBe(false)
  })

  it('is false for an SSH-scoped id (its own lease machinery owns reattach)', () => {
    const { coordinator, routing } = makeCoordinator()
    const sshId = toAppSshPtyId('conn-1', 'pty')
    routing.set(sshId, LIVE_LOCAL)
    expect(coordinator.isKnownUnattachedLocalDaemonPty(sshId)).toBe(false)
  })

  it('is false for a remote (SSH-owned) or disconnected session', () => {
    const { coordinator, routing } = makeCoordinator()
    routing.set('remote', { connectionId: 'conn-1', connected: true })
    routing.set('dead', { connectionId: null, connected: false })
    expect(coordinator.isKnownUnattachedLocalDaemonPty('remote')).toBe(false)
    expect(coordinator.isKnownUnattachedLocalDaemonPty('dead')).toBe(false)
  })

  it('clears the spawn-published marker on a new lifecycle generation', () => {
    const { coordinator, routing } = makeCoordinator()
    routing.set('pty', LIVE_LOCAL)
    coordinator.markSpawnPublished('pty')
    expect(coordinator.isKnownUnattachedLocalDaemonPty('pty')).toBe(false)
    coordinator.forgetGeneration('pty')
    expect(coordinator.isKnownUnattachedLocalDaemonPty('pty')).toBe(true)
  })
})

describe('SubscriberDrivenDaemonAttach.ensureAttach', () => {
  it('attaches a qualifying session exactly once across concurrent subscribers', () => {
    const { coordinator, attach, routing } = makeCoordinator()
    routing.set('pty', LIVE_LOCAL)
    coordinator.ensureAttach('pty')
    coordinator.ensureAttach('pty')
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledWith('pty')
  })

  it('does not attach a non-qualifying session', () => {
    const { coordinator, attach } = makeCoordinator()
    coordinator.ensureAttach('unknown')
    expect(attach).not.toHaveBeenCalled()
  })

  it('is a no-op when no controller attach is wired', () => {
    const { coordinator, attach, routing } = makeCoordinator({ getAttach: () => undefined })
    routing.set('pty', LIVE_LOCAL)
    coordinator.ensureAttach('pty')
    expect(attach).not.toHaveBeenCalled()
  })

  it('drops a failed attempt so a later subscriber retries', async () => {
    const attach = vi.fn(async () => false)
    const routing = new Map<string, LiveRouting>([['pty', LIVE_LOCAL]])
    const coordinator = new SubscriberDrivenDaemonAttach({
      getAttach: () => attach,
      hasHeadlessState: () => false,
      isProviderSnapshotPreferred: () => false,
      isRegistrationPending: () => false,
      getLocalPtyRouting: (ptyId) => routing.get(ptyId)
    })
    coordinator.ensureAttach('pty')
    // Flush the resolved-false attempt so its sticky-map cleanup runs.
    await new Promise((resolve) => setTimeout(resolve, 0))
    coordinator.ensureAttach('pty')
    expect(attach).toHaveBeenCalledTimes(2)
  })

  it('survives a synchronously-throwing controller attach', () => {
    const attach = vi.fn(() => {
      throw new Error('boom')
    })
    const routing = new Map<string, LiveRouting>([['pty', LIVE_LOCAL]])
    const coordinator = new SubscriberDrivenDaemonAttach({
      getAttach: () => attach as unknown as (ptyId: string) => Promise<boolean>,
      hasHeadlessState: () => false,
      isProviderSnapshotPreferred: () => false,
      isRegistrationPending: () => false,
      getLocalPtyRouting: (ptyId) => routing.get(ptyId)
    })
    expect(() => coordinator.ensureAttach('pty')).not.toThrow()
  })
})
