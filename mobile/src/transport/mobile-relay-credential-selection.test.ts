import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { selectDialableRelayCredentials } from './mobile-relay-credential-selection'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

function controller(): RelayReconnectController {
  return new RelayReconnectController(
    {
      now: Date.now,
      randomBytes: () => new Uint8Array([128, 0]),
      setTimer: setTimeout,
      clearTimer: clearTimeout
    },
    vi.fn()
  )
}

function bundle(version: number, expiresAt = Number.MAX_SAFE_INTEGER): MobileRelayCredentialBundle {
  return {
    v: 1,
    hostId: 'host-1',
    deviceToken: 'device',
    current: { token: `tok-${version}`, hash: `hash-${version}`, version, expiresAt }
  }
}

describe('relay credential selection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('prefers dialable in-memory credentials and never reads disk', async () => {
    const readBundle = vi.fn(async () => bundle(9))
    const selection = await selectDialableRelayCredentials({
      bundle: bundle(2),
      controller: controller(),
      readBundle
    })

    expect(selection.credentials).toHaveLength(1)
    expect(selection.bundle?.current.version).toBe(2)
    expect(readBundle).not.toHaveBeenCalled()
  })

  it('adopts a fresher durable bundle and lifts the gate when memory is rejected', async () => {
    const reconnect = controller()
    reconnect.recordRejectedCredential(2)
    const onAdoptedFresherBundle = vi.fn()

    const selection = await selectDialableRelayCredentials({
      bundle: bundle(2),
      controller: reconnect,
      readBundle: async () => bundle(3),
      onAdoptedFresherBundle
    })

    expect(selection.bundle?.current.version).toBe(3)
    expect(selection.credentials).toHaveLength(1)
    expect(onAdoptedFresherBundle).toHaveBeenCalledOnce()
    // The fresh version reopened the gate and dropped its slow reprobe timer.
    expect(reconnect.shouldDefer()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never resurrects a revoked version from a stale disk copy', async () => {
    const reconnect = controller()
    reconnect.recordRejectedCredential(2)

    const selection = await selectDialableRelayCredentials({
      bundle: bundle(2),
      controller: reconnect,
      readBundle: async () => bundle(2)
    })

    expect(selection.credentials).toHaveLength(0)
    // Still gated: the durable copy carried only the rejected version.
    expect(reconnect.shouldDefer()).toBe(true)
  })

  it('adopts the durable bundle when memory has no credential at all', async () => {
    const selection = await selectDialableRelayCredentials({
      bundle: null,
      controller: controller(),
      readBundle: async () => bundle(4)
    })

    expect(selection.bundle?.current.version).toBe(4)
    expect(selection.credentials).toHaveLength(1)
  })
})
