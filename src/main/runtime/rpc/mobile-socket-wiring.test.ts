import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Hello,
  type MobileE2EEV2Ready
} from '../../../shared/mobile-e2ee-v2-contract'
import { sealMobileE2EEV2Frame } from '../../../shared/mobile-e2ee-v2-framing'
import type { DeviceRegistry } from '../device-registry'
import { deriveSharedKey, encrypt, generateKeyPair } from './e2ee-crypto'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-key-schedule'
import {
  MobileSocketWiring,
  type MobileSocketIdentityWarmResult,
  type MobileSocketTransport,
  type MobileSocketTransportMetadata
} from './mobile-socket-wiring'

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly send = vi.fn((data: string | Buffer) => this.sent.push(data))
  readonly close = vi.fn()
}

class FakeTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  private closeHandler: Parameters<MobileSocketTransport['onConnectionClose']>[0] | null = null
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(handler: Parameters<MobileSocketTransport['onConnectionClose']>[0]): void {
    this.closeHandler = handler
  }

  receive(ws: FakeSocket, message: string): void {
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }

  disconnect(ws: FakeSocket): void {
    this.closeHandler?.(null, ws as unknown as WebSocket, false)
  }
}

function registryFor(
  deviceId: string,
  token: string,
  scope: 'mobile' | 'runtime' = 'mobile'
): DeviceRegistry {
  return {
    validateToken: (candidate: string) =>
      candidate === token
        ? {
            deviceId,
            token,
            name: 'Phone',
            scope,
            pairedAt: 1,
            lastSeenAt: 0
          }
        : null,
    updateLastSeen: vi.fn(),
    updateLastSeenDeferred: vi.fn()
  } as unknown as DeviceRegistry
}

describe('MobileSocketWiring', () => {
  it('terminates a revoked device across every attached transport', () => {
    const direct = new FakeTransport()
    const relay = new FakeTransport()
    direct.terminateClientConnections.mockReturnValue(1)
    relay.terminateClientConnections.mockReturnValue(2)
    const desktop = generateKeyPair()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => desktop.secretKey,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    const detachDirect = wiring.attachTransport(direct)
    wiring.attachTransport(relay)

    expect(wiring.terminateDeviceConnections('valid-token')).toBe(3)
    expect(direct.terminateClientConnections).toHaveBeenCalledWith('valid-token')
    expect(relay.terminateClientConnections).toHaveBeenCalledWith('valid-token')

    detachDirect()
    direct.terminateClientConnections.mockClear()
    relay.terminateClientConnections.mockClear()
    expect(wiring.terminateDeviceConnections('valid-token')).toBe(2)
    expect(direct.terminateClientConnections).not.toHaveBeenCalled()
    expect(relay.terminateClientConnections).toHaveBeenCalledWith('valid-token')
  })

  it('releases detached transports from revocation fanout under origin churn', () => {
    const desktop = generateKeyPair()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => desktop.secretKey,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    const live = new FakeTransport()
    wiring.attachTransport(live)
    const retired = Array.from({ length: 1_000 }, () => new FakeTransport())

    for (const transport of retired) {
      const detach = wiring.attachTransport(transport)
      detach()
      detach()
    }

    expect(wiring['transports'].size).toBe(1)
    expect(wiring.terminateDeviceConnections('valid-token')).toBe(0)
    expect(live.terminateClientConnections).toHaveBeenCalledOnce()
    expect(
      retired.every((transport) => transport.terminateClientConnections.mock.calls.length === 0)
    ).toBe(true)
  })

  it('preserves the legacy direct handshake, identity, and close cleanup', () => {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const onText = vi.fn()
    const onClose = vi.fn()
    const deviceRegistry = registryFor('device-1', 'valid-token', 'runtime')
    const wiring = new MobileSocketWiring({
      deviceRegistry,
      getWarmServerSecretKey: () => desktop.secretKey,
      onText,
      onBinary: vi.fn(),
      onClose
    })
    wiring.attachTransport(transport)

    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )
    const sharedKey = deriveSharedKey(phone.secretKey, desktop.publicKey)
    transport.receive(
      ws,
      encrypt(
        JSON.stringify({
          type: 'e2ee_auth',
          deviceToken: 'valid-token',
          clientCapabilities: ['session-tabs.close-intent.v1']
        }),
        sharedKey
      )
    )
    transport.receive(ws, encrypt('{"id":"rpc-1","method":"status.get"}', sharedKey))

    expect(transport.setClientId).toHaveBeenCalledWith(ws, 'valid-token')
    // Why: e2ee_authenticated must refresh lastSeen off the disk path, never inline.
    expect(deviceRegistry.updateLastSeenDeferred).toHaveBeenCalledWith('device-1')
    expect(deviceRegistry.updateLastSeen).not.toHaveBeenCalled()
    expect(onText).toHaveBeenCalledOnce()
    expect(onText.mock.calls[0]?.[0]).toMatchObject({
      device: { deviceId: 'device-1', deviceToken: 'valid-token', scope: 'runtime' },
      clientCapabilities: ['session-tabs.close-intent.v1'],
      transport: { transport: 'direct' }
    })

    transport.disconnect(ws)
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ ws }), false)
    expect(wiring.channelCount).toBe(0)
    expect(wiring.connectionCount).toBe(0)
  })

  it('closes an unknown-token socket even when reporting the failure throws', () => {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const notificationError = new Error('renderer exited')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onUnpairedDeviceAuthFailure = vi.fn(() => {
      throw notificationError
    })
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => desktop.secretKey,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn(),
      onUnpairedDeviceAuthFailure
    })
    wiring.attachTransport(transport)

    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )
    const sharedKey = deriveSharedKey(phone.secretKey, desktop.publicKey)
    expect(() =>
      transport.receive(
        ws,
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'stale-token' }), sharedKey)
      )
    ).not.toThrow()

    expect(onUnpairedDeviceAuthFailure).toHaveBeenCalledOnce()
    expect(onUnpairedDeviceAuthFailure).toHaveBeenCalledWith({ transport: 'direct' })
    expect(consoleError).toHaveBeenCalledWith(
      '[mobile] Failed to report unpaired-device auth failure:',
      notificationError
    )
    expect(transport.setClientId).not.toHaveBeenCalled()
    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized')
    expect(wiring.channelCount).toBe(0)
    consoleError.mockRestore()
  })

  it('reports auth encrypted to a stale desktop key on the direct path', () => {
    const currentDesktop = generateKeyPair()
    const staleDesktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const onUnpairedDeviceAuthFailure = vi.fn()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => currentDesktop.secretKey,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn(),
      onUnpairedDeviceAuthFailure
    })
    wiring.attachTransport(transport)

    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )
    const staleSharedKey = deriveSharedKey(phone.secretKey, staleDesktop.publicKey)
    transport.receive(
      ws,
      encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), staleSharedKey)
    )

    expect(onUnpairedDeviceAuthFailure).toHaveBeenCalledOnce()
    expect(onUnpairedDeviceAuthFailure).toHaveBeenCalledWith({ transport: 'direct' })
    expect(transport.setClientId).not.toHaveBeenCalled()
    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized')
  })

  it('rejects a relay socket whose immutable relayDeviceId differs from E2EE identity', () => {
    const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
    const phone = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const metadata: MobileSocketTransportMetadata = {
      transport: 'relay',
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'outer-device',
      basisConnId: 'connection-1',
      credentialKind: 'invite'
    }
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('e2ee-device', 'valid-token'),
      getWarmServerSecretKey: () => desktop.secretKey,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport, () => metadata)
    const hello: MobileE2EEV2Hello = {
      type: 'e2ee_hello',
      v: 2,
      clientPublicKeyB64: Buffer.from(phone.publicKey).toString('base64'),
      clientNonceB64: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: {
        protocol: 'orca-mobile-e2ee',
        initiator: 'mobile',
        responder: 'desktop',
        transport: 'relay',
        relayHostId: metadata.relayHostId
      }
    }
    transport.receive(ws, JSON.stringify(hello))
    const ready = JSON.parse(ws.sent[0]!.toString()) as MobileE2EEV2Ready
    const handshake = validateMobileE2EEV2Handshake(hello, ready)!
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: deriveSharedKey(phone.secretKey, desktop.publicKey),
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })
    const auth = sealMobileE2EEV2Frame({
      payload: new TextEncoder().encode(
        JSON.stringify({
          type: 'e2ee_auth',
          v: 2,
          transcriptHashB64: Buffer.from(schedule.transcriptHash).toString('base64'),
          deviceToken: 'valid-token'
        })
      ),
      key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind: 'text',
      counter: 0n
    })
    transport.receive(ws, Buffer.from(auth).toString('base64'))

    expect(transport.setClientId).not.toHaveBeenCalled()
    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized')
  })

  it('fails an unauthenticated first frame closed without initiating any keychain work', () => {
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Stands in for the whole keychain seam: resolving is what a remote peer must never be able
    // to trigger. The listener is on 0.0.0.0 with no pre-upgrade auth, so a resolve reachable
    // here is a remote wedge (blocking safeStorage) or a spawn-per-frame DoS (bounded helper).
    const resolveSecret = vi.fn()
    const getWarmServerSecretKey = vi.fn((): Uint8Array | null => {
      resolveSecret()
      return null
    })
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    expect(getWarmServerSecretKey).not.toHaveBeenCalled()

    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )

    expect(getWarmServerSecretKey).toHaveBeenCalledOnce()
    expect(ws.close).toHaveBeenCalledWith(4001, 'e2ee_key_unavailable')
    expect(ws.sent).toHaveLength(0)
    expect(wiring.channelCount).toBe(0)
    expect(wiring.connectionCount).toBe(0)
    expect(transport.setClientId).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('keeps refusing an unwarmed peer that ignores the close, without opening a channel', () => {
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const getWarmServerSecretKey = vi.fn((): Uint8Array | null => null)
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    // Amplification check: every extra frame costs one warm-memory read, never a keychain call.
    transport.receive(ws, 'x')
    transport.receive(ws, 'y')
    expect(getWarmServerSecretKey).toHaveBeenCalledTimes(2)
    expect(ws.close).toHaveBeenCalledTimes(2)
    expect(wiring.channelCount).toBe(0)
    expect(wiring.connectionCount).toBe(0)
    consoleError.mockRestore()
  })
})

/** A warm the test releases by hand, standing in for the child Electron process mid-boot. */
function deferredWarm(): {
  attempt: Promise<MobileSocketIdentityWarmResult>
  release: (result: MobileSocketIdentityWarmResult) => void
} {
  let release: ((result: MobileSocketIdentityWarmResult) => void) | null = null
  const attempt = new Promise<MobileSocketIdentityWarmResult>((resolve) => {
    release = resolve
  })
  return { attempt, release: (result) => release?.(result) }
}

const helloFrame = (publicKey: Uint8Array): string =>
  JSON.stringify({
    type: 'e2ee_hello',
    publicKeyB64: Buffer.from(publicKey).toString('base64')
  })

describe('MobileSocketWiring identity warm window', () => {
  it('admits a phone that connects while the startup warm is still in flight', async () => {
    // The regression this pins: the WebSocket listener binds immediately and the warm is a cold
    // child-Electron boot behind it. Refusing that window with 4001 spends the phone's whole
    // three-strike budget in ~1.5s and latches it to auth-failed — a manual re-pair, every launch.
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const onText = vi.fn()
    const warm = deferredWarm()
    const awaitServerSecretKeyWarm = vi.fn(() => warm.attempt)
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => null,
      awaitServerSecretKeyWarm,
      onText,
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    const sharedKey = deriveSharedKey(phone.secretKey, desktop.publicKey)
    transport.receive(ws, helloFrame(phone.publicKey))
    transport.receive(
      ws,
      encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), sharedKey)
    )
    transport.receive(ws, encrypt('{"id":"rpc-1","method":"status.get"}', sharedKey))

    expect(ws.close).not.toHaveBeenCalled()
    // One await for the whole socket, not one keychain question per frame.
    expect(awaitServerSecretKeyWarm).toHaveBeenCalledOnce()

    warm.release({ ok: true, serverSecretKey: desktop.secretKey })
    await warm.attempt
    await Promise.resolve()

    // Replayed in arrival order, so the handshake still sees hello before auth.
    expect(transport.setClientId).toHaveBeenCalledWith(ws, 'valid-token')
    expect(onText).toHaveBeenCalledOnce()
    expect(onText.mock.calls[0]?.[1]).toBe('{"id":"rpc-1","method":"status.get"}')
    expect(ws.close).not.toHaveBeenCalled()
    expect(wiring.channelCount).toBe(1)
  })

  it('fails closed when the awaited warm fails, and starts no keychain work of its own', async () => {
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Stands in for the whole keychain seam: a remote peer must never be able to reach it.
    const resolveSecret = vi.fn()
    const warm = deferredWarm()
    const awaitServerSecretKeyWarm = vi.fn(() => warm.attempt)
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: vi.fn((): Uint8Array | null => {
        resolveSecret()
        return null
      }),
      awaitServerSecretKeyWarm,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    transport.receive(ws, helloFrame(phone.publicKey))
    transport.receive(ws, 'noise-1')
    transport.receive(ws, 'noise-2')

    warm.release({ ok: false, retryable: true })
    await warm.attempt
    await Promise.resolve()

    // The identity is sealed, not missing — 4001 would tell the phone its pairing was revoked.
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(4002, 'e2ee_key_unsealable')
    expect(wiring.channelCount).toBe(0)
    expect(wiring.connectionCount).toBe(0)
    expect(transport.setClientId).not.toHaveBeenCalled()
    // Three frames, one desktop-owned attempt joined: no per-frame spawn, no peer-initiated resolve.
    expect(awaitServerSecretKeyWarm).toHaveBeenCalledOnce()
    expect(resolveSecret).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('still says e2ee_key_unavailable when the identity is genuinely gone', async () => {
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warm = deferredWarm()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => null,
      awaitServerSecretKeyWarm: () => warm.attempt,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    transport.receive(ws, 'x')
    warm.release({ ok: false, retryable: false })
    await warm.attempt
    await Promise.resolve()

    expect(ws.close).toHaveBeenCalledExactlyOnceWith(4001, 'e2ee_key_unavailable')
    consoleError.mockRestore()
  })

  it('asks a phone to retry while a sealed identity waits out the re-warm cooldown', async () => {
    // The live defect: 42 of 45 connections landed between re-warm attempts, where there is no
    // attempt to await. Answering 4001 there spends the phone's three-strike budget and latches
    // auth-failed on a pairing that is perfectly valid.
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => null,
      awaitServerSecretKeyWarm: () => null,
      isIdentityRetryable: () => true,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    transport.receive(ws, 'x')
    await Promise.resolve()

    expect(ws.close).toHaveBeenCalledExactlyOnceWith(4002, 'e2ee_key_unsealable')
    consoleError.mockRestore()
  })

  it('still says e2ee_key_unavailable with nothing to await and no sealed identity', async () => {
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => null,
      awaitServerSecretKeyWarm: () => null,
      isIdentityRetryable: () => false,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    transport.receive(ws, 'x')
    await Promise.resolve()

    expect(ws.close).toHaveBeenCalledExactlyOnceWith(4001, 'e2ee_key_unavailable')
    consoleError.mockRestore()
  })

  it('drops the queue of a socket that disconnects before the warm lands', async () => {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const warm = deferredWarm()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => null,
      awaitServerSecretKeyWarm: () => warm.attempt,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    transport.receive(ws, helloFrame(phone.publicKey))
    transport.disconnect(ws)

    warm.release({ ok: true, serverSecretKey: desktop.secretKey })
    await warm.attempt
    await Promise.resolve()

    // A late warm must not resurrect a channel for a socket that is already gone.
    expect(wiring.channelCount).toBe(0)
    expect(wiring.connectionCount).toBe(0)
    expect(ws.sent).toHaveLength(0)
  })

  it('caps the frames a peer can queue against one in-flight warm', () => {
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const warm = deferredWarm()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      getWarmServerSecretKey: () => null,
      awaitServerSecretKeyWarm: () => warm.attempt,
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)

    // Waiting for the warm must not become free memory: the pre-auth conversation is one hello.
    for (let i = 0; i < 40; i++) {
      transport.receive(ws, `flood-${i}`)
    }
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(4002, 'e2ee_warm_backlog')
  })
})
