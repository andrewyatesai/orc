import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

// Why: #12405 — the bind decision reads pairingReach to keep a "This computer only" grant from
// republishing the runtime on every interface one launch after the user declined that.
describe('DeviceRegistry pairingReach', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'device-registry-reach-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('defaults new grants to network reach and persists an explicit this-computer reach', () => {
    const registry = new DeviceRegistry(root)
    expect(registry.addDevice('lan', 'runtime').pairingReach).toBe('network')
    const local = registry.addDevice('local', 'runtime', 'this-computer')
    expect(local.pairingReach).toBe('this-computer')

    // Reload from disk: the reach must survive the durable write, not just the in-memory copy.
    const reloaded = new DeviceRegistry(root)
    expect(reloaded.getDevice(local.deviceId)?.pairingReach).toBe('this-computer')
  })

  it('widens a pending this-computer grant to network but never narrows it back', () => {
    const registry = new DeviceRegistry(root)
    const pending = registry.getOrCreatePendingDevice('runtime', 'runtime', 'this-computer')
    expect(pending.pairingReach).toBe('this-computer')

    // A later network offer on the same pending token upgrades it — the already-issued link stays served.
    const widened = registry.getOrCreatePendingDevice('runtime', 'runtime', 'network')
    expect(widened.deviceId).toBe(pending.deviceId)
    expect(widened.pairingReach).toBe('network')
    expect(new DeviceRegistry(root).getDevice(pending.deviceId)?.pairingReach).toBe('network')

    // Re-advertising the widened grant as this-computer must not narrow it.
    const stillWide = registry.getOrCreatePendingDevice('runtime', 'runtime', 'this-computer')
    expect(stillWide.deviceId).toBe(pending.deviceId)
    expect(stillWide.pairingReach).toBe('network')
  })

  it('treats a registry written before pairingReach existed as network reach', () => {
    const legacyDevice = {
      deviceId: 'legacy-1',
      name: 'phone',
      token: 'abc',
      scope: 'mobile',
      pairedAt: 1,
      lastSeenAt: 2
    }
    writeFileSync(join(root, DEVICE_REGISTRY_FILENAME), JSON.stringify([legacyDevice]))

    const registry = new DeviceRegistry(root)
    expect(registry.getDevice('legacy-1')?.pairingReach).toBe('network')
  })
})
