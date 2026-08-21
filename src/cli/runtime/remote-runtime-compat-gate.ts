import type { PairingOffer } from '../../shared/pairing'
import {
  describeRuntimeCompatBlock,
  evaluateRuntimeCompat
} from '../../shared/protocol-compat-verdict'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { markEnvironmentUsed } from './environments'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcResponse } from './types'
import type {
  sendWebSocketRequest,
  sendWebSocketRequestWithStatusPreflight
} from './websocket-transport'

type WebSocketTransport = {
  sendWebSocketRequest: typeof sendWebSocketRequest
  sendWebSocketRequestWithStatusPreflight: typeof sendWebSocketRequestWithStatusPreflight
}

// Why: the protocol-compat check needs a fresh `status.get`, but opening a second
// authenticated WebSocket per command doubled the E2EE handshakes. This gate rides
// the compat probe as a preflight on the command's own socket, and once any status
// has verified compatible it drops the preflight entirely.
export class RemoteRuntimeCompatGate {
  private checked = false

  constructor(
    private readonly userDataPath: string,
    private readonly environmentSelector: string | null
  ) {}

  send<TResult>(args: {
    transport: WebSocketTransport
    pairing: PairingOffer
    method: string
    params: unknown
    timeoutMs: number
  }): Promise<RuntimeRpcResponse<TResult>> {
    if (this.checked || args.method === 'status.get') {
      return args.transport.sendWebSocketRequest<TResult>(
        args.pairing,
        args.method,
        args.params,
        args.timeoutMs
      )
    }
    return args.transport.sendWebSocketRequestWithStatusPreflight<TResult>(
      args.pairing,
      args.method,
      args.params,
      args.timeoutMs,
      (response) => {
        if (response.ok === false) {
          throw new RuntimeRpcFailureError(response)
        }
        this.noteVerifiedStatus(response.result)
        if (this.environmentSelector) {
          markEnvironmentUsed(this.userDataPath, this.environmentSelector, {
            runtimeId: response._meta.runtimeId
          })
        }
      }
    )
  }

  noteVerifiedStatus(status: RuntimeStatus): void {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
      serverMinCompatibleClientProtocolVersion:
        status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
    })
    if (verdict.kind === 'blocked') {
      throw new RuntimeClientError('incompatible_runtime', describeRuntimeCompatBlock(verdict))
    }
    this.checked = true
  }
}
