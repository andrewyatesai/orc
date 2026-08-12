import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'

// Why: mock the secure-file leaf (the disk write that spawns PowerShell twice on Windows)
// so the test counts persist attempts without hitting the filesystem or an ACL spawn.
const { writeSecureJsonFile, hardenExistingSecureFile } = vi.hoisted(() => ({
  writeSecureJsonFile: vi.fn(),
  hardenExistingSecureFile: vi.fn()
}))
vi.mock('../../shared/secure-file', () => ({ writeSecureJsonFile, hardenExistingSecureFile }))

describe('DeviceRegistry deferred lastSeen', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-registry-'))
    writeSecureJsonFile.mockClear()
    hardenExistingSecureFile.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists the first sighting inline but coalesces later refreshes onto one deferred write', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone')
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(1)

    // Why: the 0 -> non-zero transition is load-bearing (rotation drops never-scanned
    // entries), so the first sighting must still write synchronously.
    registry.updateLastSeenDeferred(device.deviceId)
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(2)
    const firstSeen = registry.getDevice(device.deviceId)!.lastSeenAt
    expect(firstSeen).toBeGreaterThan(0)

    // Why: advance the clock before the next refresh so the deferred timestamp is
    // provably newer than the inline one — no pending timer exists yet to fire.
    vi.advanceTimersByTime(1_000)

    // A later refresh updates memory immediately but defers the disk write.
    registry.updateLastSeenDeferred(device.deviceId)
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(2)
    expect(registry.getDevice(device.deviceId)!.lastSeenAt).toBeGreaterThan(firstSeen)

    // A reconnect burst coalesces onto the single pending timer — still no new write.
    registry.updateLastSeenDeferred(device.deviceId)
    registry.updateLastSeenDeferred(device.deviceId)
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(2)

    // The coalesced timer lands exactly one write for the whole burst.
    vi.advanceTimersByTime(250)
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(3)

    // Nothing is pending afterwards, so a manual flush is a no-op.
    registry.flushPendingLastSeen()
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(3)
  })

  it('flushPendingLastSeen persists a pending refresh immediately', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone')
    registry.updateLastSeenDeferred(device.deviceId) // first sighting persists inline
    writeSecureJsonFile.mockClear()

    vi.advanceTimersByTime(1_000)
    registry.updateLastSeenDeferred(device.deviceId) // deferred
    expect(writeSecureJsonFile).not.toHaveBeenCalled()

    registry.flushPendingLastSeen()
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(1)

    // The now-cancelled timer must not fire a second write.
    vi.advanceTimersByTime(250)
    expect(writeSecureJsonFile).toHaveBeenCalledTimes(1)
  })
})
