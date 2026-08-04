import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { RelayDemandLedger } from './relay-demand-ledger'
import { RelayRevokeOutbox, type RelayDeviceBinding } from './relay-revoke-outbox'

const ownerIdentityKey = 'user-1\0profile-1\0org-1'
const relayHostId = 'relay-host-1'

function fixture(now: number) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-demand-'))
  const deviceRegistry = new DeviceRegistry(userDataPath)
  const revokeOutbox = new RelayRevokeOutbox(userDataPath)
  const ledger = new RelayDemandLedger({
    deviceRegistry,
    revokeOutbox,
    relayHostId: () => relayHostId,
    now: () => now
  })
  return { userDataPath, deviceRegistry, revokeOutbox, ledger }
}

function binding(relayDeviceId: string, inviteExpiresAt?: number): RelayDeviceBinding {
  return { relayDeviceId, relayHostId, ownerIdentityKey, inviteExpiresAt }
}

describe('RelayDemandLedger', () => {
  it('reference-counts concurrent main-process work', () => {
    const { ledger } = fixture(1_000)
    const releaseFirst = ledger.acquireTransient('pairing:device-1')
    const releaseSecond = ledger.acquireTransient('pairing:device-1')
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)
    releaseFirst()
    releaseFirst()
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)
    releaseSecond()
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })

  it('holds pending QR demand only through invite expiry', () => {
    const { userDataPath, deviceRegistry, ledger } = fixture(1_000)
    const pending = deviceRegistry.addDevice('Pending phone')
    deviceRegistry.setRelayBinding(pending.deviceId, binding(pending.deviceId, 2_000))
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)
    expect(ledger.nextPendingExpiry()).toBe(2_000)
    const restarted = new RelayDemandLedger({
      deviceRegistry: new DeviceRegistry(userDataPath),
      revokeOutbox: new RelayRevokeOutbox(userDataPath),
      relayHostId: () => relayHostId,
      now: () => 1_500
    })
    expect(restarted.hasDemand(ownerIdentityKey)).toBe(true)

    const expiredFixture = fixture(3_000)
    const expired = expiredFixture.deviceRegistry.addDevice('Expired phone')
    expiredFixture.deviceRegistry.setRelayBinding(
      expired.deviceId,
      binding(expired.deviceId, 2_000)
    )
    expect(expiredFixture.ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })

  it('does not promote a scanned invite to provisioned demand before install', () => {
    const { deviceRegistry, ledger } = fixture(3_000)
    const scanned = deviceRegistry.addDevice('Scanned phone')
    deviceRegistry.setRelayBinding(scanned.deviceId, binding(scanned.deviceId, 2_000))
    deviceRegistry.updateLastSeen(scanned.deviceId)
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })

  it('keeps provisioned devices and revoke outbox work authoritative', () => {
    const { deviceRegistry, revokeOutbox, ledger } = fixture(5_000)
    const paired = deviceRegistry.addDevice('Paired phone')
    deviceRegistry.setRelayBinding(paired.deviceId, binding(paired.deviceId))
    deviceRegistry.updateLastSeen(paired.deviceId)
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)

    deviceRegistry.removeDevice(paired.deviceId)
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
    revokeOutbox.enqueue(binding(paired.deviceId))
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)
  })

  it('derives the relay host id per query, never at construction', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-demand-'))
    const resolveHostId = vi.fn(() => relayHostId)
    const ledger = new RelayDemandLedger({
      deviceRegistry: new DeviceRegistry(userDataPath),
      revokeOutbox: new RelayRevokeOutbox(userDataPath),
      relayHostId: resolveHostId,
      now: () => 1_000
    })

    // The host id comes from the E2EE keypair, whose keychain read must stay off app startup.
    expect(resolveHostId).not.toHaveBeenCalled()
    expect(ledger.nextPendingExpiry()).toBeNull()
    expect(resolveHostId).not.toHaveBeenCalled()
    ledger.hasDemand(ownerIdentityKey)
    expect(resolveHostId).toHaveBeenCalled()
  })

  it('does not activate another signed-in identity or relay host', () => {
    const { deviceRegistry, ledger } = fixture(1_000)
    const pending = deviceRegistry.addDevice('Other phone')
    deviceRegistry.setRelayBinding(pending.deviceId, {
      ...binding(pending.deviceId, 2_000),
      ownerIdentityKey: 'other-user\0profile\0org'
    })
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })
})
