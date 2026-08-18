import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  bundle,
  dependencies,
  host,
  relay
} from './mobile-endpoint-supervisor-test-harness'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile endpoint supervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails over to a confirmed relay session and persists its renewed expiry', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(logical.migrateTo).toHaveBeenCalledWith(expect.any(FakeRelaySession), 'relay')
    expect(logical.getActivePath()).toBe('relay')
    expect(deps.writeBundle).toHaveBeenCalledWith(
      expect.objectContaining({ current: expect.objectContaining({ version: 2 }) })
    )
    supervisor.stop()
  })

  it('fails over when the direct retry loop publishes reconnecting', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    logical.publishState('handshaking')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).not.toHaveBeenCalled()

    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).not.toHaveBeenCalled()

    logical.publishState('reconnecting')
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('relay'))

    expect(logical.migrateTo).toHaveBeenCalledWith(expect.any(FakeRelaySession), 'relay')
    supervisor.stop()
  })

  it('fails over when direct is already reconnecting before startup completes', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(logical.migrateTo).toHaveBeenCalledWith(expect.any(FakeRelaySession), 'relay')
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('does not spend a queued relay retry while direct authentication is progressing', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('handshaking')
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    supervisor.stop()
  })

  it('presents Relay recovery through a failed dial cooldown and clears it on stop', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const deps = dependencies({
      openRelay: vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408))),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    // Why: a real eligible-credential relay dial must publish the pending path so
    // the header can say "Connecting via Relay…" instead of a failed direct hint.
    expect(logical.setRecoveryPath).toHaveBeenCalledWith('relay', 0)
    expect(logical.getPendingPath()).toBe('relay')
    await vi.advanceTimersByTimeAsync(249)
    expect(logical.getPendingPath()).toBe('relay')

    supervisor.stop()
    expect(logical.getPendingPath()).toBeNull()
  })

  it('does not present Relay recovery when no credential can dial', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const expired = { ...bundle, current: { ...bundle.current, expiresAt: Date.now() - 1 } }
    const deps = dependencies({ readBundle: vi.fn(async () => expired) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.setRecoveryPath).not.toHaveBeenCalledWith('relay')
    expect(logical.getPendingPath()).toBeNull()
    supervisor.stop()
  })

  it('uses POST resolve for wrong-cell recovery and persists the authoritative target', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
    const resolved = { ...relay, cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 }
    const deps = dependencies({
      openRelay,
      resolveRelay: vi.fn(async () => resolved)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(deps.resolveRelay).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenLastCalledWith(resolved, expect.any(Object), expect.any(String))
    expect(deps.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({ relay: resolved, endpoint: host.endpoint })
    )
    supervisor.stop()
  })

  it('promotes direct only after repeated foreground authenticated probes and dwell', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(45_000)
    expect(logical.getActivePath()).toBe('relay')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(logical.getActivePath()).toBe('lan')
    expect(deps.openDirect).toHaveBeenCalledTimes(4)
    supervisor.stop()
  })

  it('recovers the relay when it drops during an unavailable direct probe', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const direct = new FakeSession('connecting')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openDirect: vi.fn(() => direct),
      openRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    // Start the probe, then drop the active relay while the probe owns the
    // operation mutex. The failed probe must hand recovery back to the relay.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    logical.publishState('disconnected')
    direct.publishState('disconnected')

    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce())
    supervisor.stop()
  })

  it('replaces a half-open relay on a network nudge, then backs off failed resumes', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected'))
      .mockImplementation(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      // Keep direct unavailable so relay recovery stays the only path under test.
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      // Deterministic full jitter: fraction 0.5 → half the backoff window.
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    // The OS reports a network handoff, but the dead relay never published onclose.
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenCalledTimes(2)

    // The relay cell rejects the replacement with PEER_DROPPED; more flap nudges
    // must share the existing cooldown rather than opening more sockets.
    for (let i = 0; i < 5; i++) {
      supervisor.setForeground(true)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(openRelay).toHaveBeenCalledTimes(2)

    // Exactly one retry fires at the 250 ms deterministic backoff boundary.
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)
    supervisor.stop()
  })

  it('backs off a close from the active relay before opening its replacement', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', new RelayOuterError(4429)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('disconnected')

    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('escalates backoff when relay sessions connect and then drop repeatedly', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(2)

    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(499)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)

    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(999)
    expect(openRelay).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(4)
    supervisor.stop()
  })

  it('does not try a grace credential for a capacity failure before backing off', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4429)))
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('does not redial a rejected current credential on grace cooldown retries', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(
      (_relay, credential: { version: number }) =>
        new FakeRelaySession(
          'disconnected',
          new RelayOuterError(credential.version === bundle.current.version ? 4401 : 4429)
        )
    )
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(3)
    expect(openRelay.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ version: 1 }))
    supervisor.stop()
  })

  it('rotates a rejected current credential after grace keeps relay recovery alive', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const current = {
      ...bundle.current,
      hash: hashMobileRelayCredential(bundle.current.token)
    }
    const writeBundle = vi.fn(async () => {})
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        current,
        grace: { ...current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay: vi.fn(
        (_relay, credential: { version: number }) =>
          new FakeRelaySession(
            credential.version === current.version ? 'disconnected' : 'connected',
            credential.version === current.version ? new RelayOuterError(4401) : null
          )
      ),
      writeBundle
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    writeBundle.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(writeBundle).toHaveBeenCalledWith(
      expect.objectContaining({ pending: expect.any(Object) })
    )
    supervisor.stop()
  })

  it('does not duplicate transport failures across current and grace credentials', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new Error('network down')))
    const resolveRelay = vi.fn(async () => {
      throw new Error('director unreachable')
    })
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      resolveRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledOnce()
    expect(resolveRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('keeps an authenticated relay off the backoff path when persistence fails', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      writeBundle: vi.fn(async () => {
        throw new Error('secure store unavailable')
      })
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    supervisor.stop()
  })
})
