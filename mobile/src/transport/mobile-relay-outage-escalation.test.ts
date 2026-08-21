import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyConnection } from './connection-health'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeRelaySession,
  FakeSession,
  host
} from './mobile-endpoint-supervisor-test-harness'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// Mirrors connection-health's UNREACHABLE_ATTEMPTS threshold.
const UNREACHABLE_ATTEMPTS = 12

describe('continuous Relay outage escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T04:00:00Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('projects supervisor recovery attempts so a flapping Relay escalates the verdict', async () => {
    const failure = new RelayOuterError(4408)
    const activeRelay = new FakeRelaySession('connected', failure)
    // Why: the last authenticated relay is stale, so escalation must fire off the
    // recovery streak — not a fresh connection.
    activeRelay.getLastConnectedAt = () => Date.now() - 120_000
    // Why: the real logical client is the production seam — its getReconnectAttempt
    // must reflect the supervisor's streak for classifyConnection to escalate.
    const logical = createStableLogicalRpcClient(new FakeSession('disconnected'), 'tailscale')
    const publishedAttempts: number[] = []
    logical.onConnectionPathChange(() => publishedAttempts.push(logical.getReconnectAttempt()))
    const openRelay = vi.fn(() => {
      const session = new FakeRelaySession('connecting', failure)
      setTimeout(() => session.publishState('disconnected'), 0)
      return session
    })
    openRelay.mockReturnValueOnce(activeRelay)
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      openRelay,
      // Zero jitter pins each transport retry to its 250ms floor.
      randomBytes: () => new Uint8Array([0, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    // The supervisor-established Relay begins a continuous outage.
    expect(logical.getReconnectAttempt()).toBe(0)

    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(6_000)

    expect(logical.getPendingPath()).toBe('relay')
    expect(logical.getReconnectAttempt()).toBeGreaterThanOrEqual(UNREACHABLE_ATTEMPTS)
    // The published count tracks the projected reconnect attempt.
    expect(publishedAttempts.at(-1)).toBe(logical.getReconnectAttempt())
    expect(
      classifyConnection({
        state: logical.getState(),
        reconnectAttempts: logical.getReconnectAttempt(),
        lastConnectedAt: logical.getLastConnectedAt(),
        pendingPath: logical.getPendingPath()
      })
    ).toMatchObject({ kind: 'unreachable', label: "Can't connect via Relay" })

    supervisor.stop()
    logical.close()
  })
})
