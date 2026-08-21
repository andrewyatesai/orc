import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  bundle,
  dependencies,
  host,
  mockCredentialRotation,
  relay
} from './mobile-endpoint-supervisor-test-harness'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile endpoint supervisor recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels a pending relay retry when the original direct path reconnects', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies({
      openRelay: vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408))),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(vi.getTimerCount()).toBe(1)

    logical.publishState('connected')
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('recovers a relay drop while post-migration persistence owns the mutex', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishWrite: (() => void) | undefined
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', new RelayOuterError(4408)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      writeBundle: vi.fn(() => writePending),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())
    logical.publishState('disconnected')
    finishWrite?.()
    await starting

    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('retries a host-offline relay without requiring an external signal', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4404)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledOnce()
    logical.publishState('disconnected')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    supervisor.stop()
  })

  it('waits for direct connectivity before replacing a rejected relay credential', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4401)))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(1000)

    expect(openRelay).toHaveBeenCalledOnce()
    expect(deps.writeBundle).not.toHaveBeenCalled()

    logical.publishState('connected')
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())
    supervisor.stop()
  })

  it('keeps rejected relay credentials gated until their replacement is durable', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    let finishCredentialWrite: (() => void) | undefined
    const credentialWritePending = new Promise<void>((resolve) => {
      finishCredentialWrite = resolve
    })
    const writeBundle = vi
      .fn<(value: MobileRelayCredentialBundle) => Promise<void>>()
      .mockResolvedValue()
      .mockResolvedValueOnce()
      .mockReturnValueOnce(credentialWritePending)
    mockCredentialRotation(logical)
    const deps = dependencies({ openRelay, writeBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('connected')
    await vi.waitFor(() => expect(writeBundle).toHaveBeenCalledTimes(2))

    // The direct socket can disappear after the server commits but before the
    // replacement credential finishes its durable write.
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    finishCredentialWrite?.()
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    expect(openRelay).toHaveBeenLastCalledWith(
      relay,
      expect.objectContaining({ version: 3 }),
      expect.any(String)
    )
    supervisor.stop()
  })

  it('uses a scheduled credential rotation that finishes after relay rejection', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    let finishCredentialWrite: (() => void) | undefined
    const credentialWritePending = new Promise<void>((resolve) => {
      finishCredentialWrite = resolve
    })
    const writeBundle = vi
      .fn<(value: MobileRelayCredentialBundle) => Promise<void>>()
      .mockResolvedValue()
      .mockResolvedValueOnce()
      .mockReturnValueOnce(credentialWritePending)
    mockCredentialRotation(logical)
    const openRelay = vi.fn(
      (_relay, credential: { version: number }) =>
        new FakeRelaySession(
          credential.version === bundle.current.version ? 'disconnected' : 'connected',
          credential.version === bundle.current.version ? new RelayOuterError(4401) : null
        )
    )
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        current: { ...bundle.current, expiresAt: Date.now() + 60_000 }
      })),
      openRelay,
      writeBundle
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('connected')
    await vi.waitFor(() => expect(writeBundle).toHaveBeenCalledTimes(2))

    // The expiring credential can be rejected while its replacement is waiting on SecureStore.
    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce())
    finishCredentialWrite?.()

    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    expect(openRelay).toHaveBeenLastCalledWith(
      relay,
      expect.objectContaining({ version: 3 }),
      expect.any(String)
    )
    supervisor.stop()
  })

  it('does not open a resolved relay replacement after backgrounding', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishResolve: ((value: typeof relay) => void) | undefined
    const resolvePending = new Promise<typeof relay>((resolve) => {
      finishResolve = resolve
    })
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      resolveRelay: vi.fn(() => resolvePending)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.resolveRelay).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    finishResolve?.(relay)
    await starting

    expect(openRelay).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('does not recreate a lease retry after forced replacement is backgrounded', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishResolve: ((value: typeof relay) => void) | undefined
    const resolvePending = new Promise<typeof relay>((resolve) => {
      finishResolve = resolve
    })
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', null, Date.now() + 31_000))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      resolveRelay: vi.fn(() => resolvePending)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(deps.resolveRelay).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    finishResolve?.(relay)
    await vi.waitFor(() => expect(deps.saveHost).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(0)

    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('does not recreate a lease timer after stop races relay persistence', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishWrite: (() => void) | undefined
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const deps = dependencies({ writeBundle: vi.fn(() => writePending) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())
    supervisor.stop()
    finishWrite?.()
    await starting

    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not poll a host-offline relay through forced lease retries', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', null, Date.now() + 31_000))
      .mockImplementation(() => new FakeRelaySession('disconnected', new RelayOuterError(4404)))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5000)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('keeps a fatal lease-replacement gate after the active relay later drops', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(
        new FakeRelaySession('connected', new RelayOuterError(4408), Date.now() + 31_000)
      )
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    // The old relay can outlive its rejected lease replacement, then close separately.
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('keeps revival nudges inside a failed lease rotation cooldown', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', null, Date.now() + 31_000))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4429)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)
    supervisor.stop()
  })

  it('keeps lease rotation inside an active relay failure cooldown', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(
        new FakeRelaySession('connected', new RelayOuterError(4429), Date.now() + 31_000)
      )
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(900)
    logical.publishState('disconnected')

    await vi.advanceTimersByTimeAsync(100)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(150)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('clears relay backoff on a genuine foreground so the retry is immediate', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    const afterStart = openRelay.mock.calls.length

    // Background → foreground is a fresh signal: dial now, not after the cooldown.
    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay.mock.calls.length).toBeGreaterThan(afterStart)
    supervisor.stop()
  })

  it('releases a background relay session and reconnects it on foreground', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)

    supervisor.setForeground(true)
    await vi.waitFor(() => expect(logical.migrateTo).toHaveBeenCalled())
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })
})
