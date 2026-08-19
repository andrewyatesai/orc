import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { DeviceEntry, DeviceRegistry } from '../device-registry'
import { E2EEChannel, type E2EEAuthenticatedDevice } from './e2ee-channel'
import {
  MobileSocketIdentityWarmGate,
  type MobileSocketIdentityWarmOptions,
  type MobileSocketPayload
} from './mobile-socket-identity-warm-gate'
import { createMobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'
import type { RuntimeCapability } from '../../../shared/protocol-version'

export type { MobileSocketIdentityWarmResult } from './mobile-socket-identity-warm-gate'

export type MobileSocketTransportMetadata =
  | { transport: 'direct' }
  | {
      transport: 'relay'
      relayHostId: string
      relayDeviceId: string
      basisConnId: string
      credentialKind: 'invite' | 'resume'
    }

export type MobileSocketTransport = {
  onMessage(
    handler: (
      message: MobileSocketPayload,
      reply: (response: string) => void,
      ws: WebSocket
    ) => void
  ): void
  onConnectionClose(
    handler: (clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void
  setClientId(ws: WebSocket, clientId: string): void
  terminateClientConnections(clientId: string): number
}

export type AuthenticatedMobileSocket = {
  ws: WebSocket
  connectionId: string
  device: E2EEAuthenticatedDevice
  clientCapabilities: readonly RuntimeCapability[]
  transport: MobileSocketTransportMetadata
}

type MobileSocketWiringOptions = MobileSocketIdentityWarmOptions & {
  deviceRegistry: DeviceRegistry
  onText: (
    socket: AuthenticatedMobileSocket,
    plaintext: string,
    reply: (response: string) => void,
    sendBinary: (response: Uint8Array<ArrayBufferLike>) => boolean | void
  ) => void
  onBinary: (socket: AuthenticatedMobileSocket, bytes: Uint8Array<ArrayBufferLike>) => void
  onClose: (socket: AuthenticatedMobileSocket | null, hasOtherConnections: boolean) => void
  onReady?: (socket: AuthenticatedMobileSocket) => void
  // Why: stale keys and missing registry entries both fail before RPC can explain the re-pair action.
  onUnpairedDeviceAuthFailure?: (metadata: MobileSocketTransportMetadata) => void
}

function toAuthenticatedDevice(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    deviceId: device.deviceId,
    deviceToken: device.token,
    scope: device.scope
  }
}

export class MobileSocketWiring {
  private readonly deviceRegistry: DeviceRegistry
  private readonly identityWarmGate: MobileSocketIdentityWarmGate
  private readonly onText: MobileSocketWiringOptions['onText']
  private readonly onBinary: MobileSocketWiringOptions['onBinary']
  private readonly onClose: MobileSocketWiringOptions['onClose']
  private readonly onReady: MobileSocketWiringOptions['onReady']
  private readonly onUnpairedDeviceAuthFailure: MobileSocketWiringOptions['onUnpairedDeviceAuthFailure']
  private readonly channels = new Map<WebSocket, E2EEChannel>()
  private readonly connectionIds = new Map<WebSocket, string>()
  private readonly authenticatedSockets = new Map<WebSocket, AuthenticatedMobileSocket>()
  private readonly transports = new Set<MobileSocketTransport>()
  private readonly outboundMemoryBudget = createMobileE2EEOutboundMemoryBudget()

  constructor(options: MobileSocketWiringOptions) {
    this.deviceRegistry = options.deviceRegistry
    this.identityWarmGate = new MobileSocketIdentityWarmGate(options)
    this.onText = options.onText
    this.onBinary = options.onBinary
    this.onClose = options.onClose
    this.onReady = options.onReady
    this.onUnpairedDeviceAuthFailure = options.onUnpairedDeviceAuthFailure
  }

  attachTransport(
    transport: MobileSocketTransport,
    getMetadata: (ws: WebSocket) => MobileSocketTransportMetadata = () => ({
      transport: 'direct'
    })
  ): () => void {
    this.transports.add(transport)
    transport.onMessage((message, _reply, ws) => {
      this.handleRawMessage(transport, ws, message, getMetadata(ws))
    })
    transport.onConnectionClose((_clientId, ws) => this.handleClose(ws))
    let attached = true
    return () => {
      if (!attached) {
        return
      }
      attached = false
      this.transports.delete(transport)
    }
  }

  getConnectionId(ws: WebSocket): string | undefined {
    return this.connectionIds.get(ws)
  }

  get channelCount(): number {
    return this.channels.size
  }

  get connectionCount(): number {
    return this.connectionIds.size
  }

  terminateDeviceConnections(deviceToken: string): number {
    let terminated = 0
    for (const transport of this.transports) {
      terminated += transport.terminateClientConnections(deviceToken)
    }
    return terminated
  }

  private handleRawMessage(
    transport: MobileSocketTransport,
    ws: WebSocket,
    message: MobileSocketPayload,
    metadata: MobileSocketTransportMetadata
  ): void {
    const channel = this.channels.get(ws)
    if (channel) {
      channel.handleRawMessage(message)
      return
    }
    const serverSecretKey = this.identityWarmGate.admit(ws, message, (warmKey, frames) =>
      this.replayFramesOnWarmedChannel(transport, ws, warmKey, metadata, frames)
    )
    if (serverSecretKey) {
      this.openChannel(transport, ws, serverSecretKey, metadata).handleRawMessage(message)
    }
  }

  private replayFramesOnWarmedChannel(
    transport: MobileSocketTransport,
    ws: WebSocket,
    serverSecretKey: Uint8Array,
    metadata: MobileSocketTransportMetadata,
    frames: readonly MobileSocketPayload[]
  ): void {
    const channel = this.openChannel(transport, ws, serverSecretKey, metadata)
    for (const frame of frames) {
      // Why: a failed handshake destroys the channel mid-drain; the rest of the queue is dead with it.
      if (this.channels.get(ws) !== channel) {
        return
      }
      channel.handleRawMessage(frame)
    }
  }

  private openChannel(
    transport: MobileSocketTransport,
    ws: WebSocket,
    serverSecretKey: Uint8Array,
    metadata: MobileSocketTransportMetadata
  ): E2EEChannel {
    const connectionId = randomBytes(8).toString('hex')
    this.connectionIds.set(ws, connectionId)
    const channel = new E2EEChannel(ws, {
      serverSecretKey,
      transportContext:
        metadata.transport === 'relay'
          ? { transport: 'relay', relayHostId: metadata.relayHostId }
          : { transport: 'direct' },
      requireV2: metadata.transport === 'relay',
      outboundMemoryBudget: this.outboundMemoryBudget,
      resolveAuthenticatedDevice: (token) => {
        const device = this.deviceRegistry.validateToken(token)
        if (!device) {
          return null
        }
        // Why: outer relay authorization cannot choose the local Orca
        // identity; E2EE must resolve the same device before readiness.
        if (metadata.transport === 'relay' && metadata.relayDeviceId !== device.deviceId) {
          return null
        }
        return toAuthenticatedDevice(device)
      },
      onReady: (channel, device) => {
        const socket = {
          ws,
          connectionId,
          device,
          clientCapabilities: channel.clientCapabilities,
          transport: metadata
        }
        this.authenticatedSockets.set(ws, socket)
        transport.setClientId(ws, device.deviceToken)
        this.deviceRegistry.updateLastSeen(device.deviceId)
        this.onReady?.(socket)
      },
      onError: (code, reason) => {
        const reportUnpairedDevice = code === 4001 && reason === 'Unauthorized'
        this.channels.get(ws)?.destroy()
        this.channels.delete(ws)
        ws.close(code, reason)
        if (reportUnpairedDevice) {
          try {
            this.onUnpairedDeviceAuthFailure?.(metadata)
          } catch (error) {
            // Why: renderer teardown can make UI delivery throw; auth cleanup must remain authoritative.
            console.error('[mobile] Failed to report unpaired-device auth failure:', error)
          }
        }
      }
    })
    channel.onMessage((plaintext, reply, sendBinary) => {
      const socket = this.authenticatedSockets.get(ws)
      if (socket) {
        this.onText(socket, plaintext, reply, sendBinary)
      }
    })
    channel.onBinaryMessage((bytes) => {
      const socket = this.authenticatedSockets.get(ws)
      if (socket) {
        this.onBinary(socket, bytes)
      }
    })
    this.channels.set(ws, channel)
    return channel
  }

  private handleClose(ws: WebSocket): void {
    this.identityWarmGate.forget(ws)
    const socket = this.authenticatedSockets.get(ws) ?? null
    this.authenticatedSockets.delete(ws)
    this.channels.get(ws)?.destroy()
    this.channels.delete(ws)
    this.connectionIds.delete(ws)
    const hasOtherConnections =
      socket !== null &&
      Array.from(this.authenticatedSockets.values()).some(
        (candidate) => candidate.device.deviceToken === socket.device.deviceToken
      )
    this.onClose(socket, hasOtherConnections)
  }
}
