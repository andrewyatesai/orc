import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import { DeviceRegistry } from '../device-registry'
import { RelayRevokeOutbox } from './relay-revoke-outbox'
import type { MobilePairingConnectionContext, OrcaRuntimeRpcServer } from '../runtime-rpc'
import { DesktopRelayService, pairingAuthorizationForContext } from './desktop-relay-service'

const relayHostId = 'AbCdEf0123_-xyZ9'

function context(
  transport: MobilePairingConnectionContext['transport']
): MobilePairingConnectionContext {
  return { deviceId: 'device-1', connectionId: 'e2ee-connection-1', transport }
}

describe('pairingAuthorizationForContext', () => {
  it('derives direct authorization only from the authenticated connection', () => {
    expect(pairingAuthorizationForContext(context({ transport: 'direct' }), relayHostId)).toEqual({
      mode: 'authenticated-direct',
      directAuthId: 'e2ee-connection-1'
    })
  })

  it('derives invite authorization only from immutable relay metadata', () => {
    expect(
      pairingAuthorizationForContext(
        context({
          transport: 'relay',
          relayHostId,
          relayDeviceId: 'device-1',
          basisConnId: 'relay-basis-1',
          credentialKind: 'invite'
        }),
        relayHostId
      )
    ).toEqual({ mode: 'relay-basis', basisConnId: 'relay-basis-1' })
  })

  it('reserves resume metadata for confirmation and rejects stale hosts', () => {
    expect(
      pairingAuthorizationForContext(
        context({
          transport: 'relay',
          relayHostId,
          relayDeviceId: 'device-1',
          basisConnId: 'resume-basis-1',
          credentialKind: 'resume'
        }),
        relayHostId
      )
    ).toBeNull()
    expect(() =>
      pairingAuthorizationForContext(
        context({
          transport: 'relay',
          relayHostId: 'stale-host-id-1',
          relayDeviceId: 'device-1',
          basisConnId: 'relay-basis-1',
          credentialKind: 'invite'
        }),
        relayHostId
      )
    ).toThrow('stale_relay_connection')
  })
})

describe('DesktopRelayService construction', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not resolve the E2EE keypair, so GUI startup never blocks on the OS keychain', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-service-'))
    dirs.push(userDataPath)
    const getE2EEKeypair = vi.fn(() => null)
    const runtimeRpc = {
      getE2EEKeypair,
      getMobileSocketWiring: () => ({}),
      getDeviceRegistry: () => new DeviceRegistry(userDataPath),
      getRelayRevokeOutbox: () => new RelayRevokeOutbox(userDataPath)
    } as unknown as OrcaRuntimeRpcServer

    const service = new DesktopRelayService({
      authConfig: {} as OrcaCloudAuthConfig,
      userDataPath,
      appVersion: '0.0.0',
      runtimeRpc,
      onStatus: () => {}
    })

    // Revert guard: this runs inline with app startup, and getE2EEKeypair() can sit on a
    // synchronous macOS Keychain prompt that nothing on the main thread can time out.
    expect(service).toBeInstanceOf(DesktopRelayService)
    expect(getE2EEKeypair).not.toHaveBeenCalled()
  })

  it('defers demand refresh until the E2EE identity is warm', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-service-'))
    dirs.push(userDataPath)
    let warm = false
    const runtimeRpc = {
      // Demand derives the relay host id from the keypair, so it throws until the identity lands.
      getE2EEKeypair: () =>
        warm
          ? { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32), publicKeyB64: '' }
          : null,
      resolveE2EEIdentity: async () => {
        warm = true
        return {
          ok: true as const,
          keypair: {
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(32),
            publicKeyB64: ''
          }
        }
      },
      getMobileSocketWiring: () => ({}),
      getDeviceRegistry: () => new DeviceRegistry(userDataPath),
      getRelayRevokeOutbox: () => new RelayRevokeOutbox(userDataPath)
    } as unknown as OrcaRuntimeRpcServer

    const service = new DesktopRelayService({
      authConfig: {} as OrcaCloudAuthConfig,
      userDataPath,
      appVersion: '0.0.0',
      runtimeRpc,
      onStatus: () => {}
    })

    // Revert guard: a synchronous refresh would throw mobile_runtime_not_ready, and index.ts
    // catches that once — leaving Relay off for the entire session.
    expect(() => service.start()).not.toThrow()
    await vi.waitFor(() => expect(warm).toBe(true))
  })

  it('still refuses to construct while the mobile runtime is not wired up', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-service-'))
    dirs.push(userDataPath)
    const runtimeRpc = {
      getE2EEKeypair: () => null,
      getMobileSocketWiring: () => null,
      getDeviceRegistry: () => new DeviceRegistry(userDataPath),
      getRelayRevokeOutbox: () => new RelayRevokeOutbox(userDataPath)
    } as unknown as OrcaRuntimeRpcServer

    expect(
      () =>
        new DesktopRelayService({
          authConfig: {} as OrcaCloudAuthConfig,
          userDataPath,
          appVersion: '0.0.0',
          runtimeRpc,
          onStatus: () => {}
        })
    ).toThrow('mobile_runtime_not_ready')
  })
})

describe('local-only mobile pairing', () => {
  it('refuses endpoint discovery and provisioning without opening Relay demand', async () => {
    const registry = {
      getDevice: () => ({ deviceId: 'device-1', scope: 'mobile' }),
      getMobilePairingConnectionMode: () => 'local-only'
    }
    const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
    Object.defineProperty(service, 'runtimeRpc', {
      value: { getDeviceRegistry: () => registry }
    })

    await expect(service.getEndpoints(context({ transport: 'direct' }), {})).resolves.toEqual({
      v: 1,
      relay: null
    })
    await expect(
      service.provisionRelay(context({ transport: 'direct' }), {
        reqId: 'install-1',
        newResumeTokenHash: 'A'.repeat(43)
      })
    ).rejects.toThrow('relay_disabled_for_device')
  })
})
