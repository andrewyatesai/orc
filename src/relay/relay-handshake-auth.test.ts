import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { allowedMethodsForRole, setupDaemonHandshake } from './relay-handshake'
import { RelayDispatcher } from './dispatcher'
import {
  FrameDecoder,
  MessageType,
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  parseHandshakeMessage,
  parseJsonRpcMessage,
  type DecodedFrame,
  type JsonRpcResponse
} from './protocol'
import { relayTestSocketPath } from './relay-test-socket-path'
import {
  deriveRelayCliSecret,
  relayAuthVerifier,
  type RelayAuthRole
} from '../shared/ssh-relay-auth-token'

// The attack this file is about: any process on the remote host that can reach
// the relay socket used to be able to drive the channel — including `orca.cli`,
// which is forwarded back to the user's laptop. The socket's 0600 mode is a
// remote-uid boundary, and remote-uid is not host-uid, so the credential is what
// stands between a compromised remote account and code execution on the host.

const CONTROL_SECRET = 'a'.repeat(64)
const CLI_SECRET = deriveRelayCliSecret(CONTROL_SECRET)
const AUTH = {
  control: relayAuthVerifier(CONTROL_SECRET),
  cli: relayAuthVerifier(CLI_SECRET)
}

describe('relay socket authentication', () => {
  let server: Server
  let sockPath: string
  let tmpDir: string
  let dispatchers: RelayDispatcher[]
  let liveSockets: Socket[]
  /** Every verb the dispatcher actually ran, in order — the thing a refusal must keep empty. */
  let served: string[]
  let acceptedRoles: RelayAuthRole[]
  let stderrWrite: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-relay-auth-'))
    sockPath = relayTestSocketPath(tmpDir)
    dispatchers = []
    liveSockets = []
    served = []
    acceptedRoles = []
    stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)
  })

  afterEach(async () => {
    stderrWrite.mockRestore()
    for (const d of dispatchers) {
      d.dispose()
    }
    for (const s of liveSockets) {
      s.destroy()
    }
    if (server) {
      await new Promise<void>((r) => server.close(() => r()))
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // A daemon shaped like relay.ts's: handshake first, dispatcher only after.
  async function startDaemon(version = '0.1.0+test'): Promise<void> {
    server = createServer((sock) => {
      liveSockets.push(sock)
      setupDaemonHandshake(sock, {
        launchVersion: version,
        auth: AUTH,
        onAccepted: (accepted, leftover, role) => {
          acceptedRoles.push(role)
          const dispatcher = new RelayDispatcher((data) => accepted.write(data))
          dispatchers.push(dispatcher)
          for (const method of ['relay.status', 'orca.cli']) {
            dispatcher.onRequest(method, async () => {
              served.push(method)
              return { ok: method }
            })
          }
          const clientId = dispatcher.attachClient((data) => accepted.write(data), undefined, {
            allowedMethods: allowedMethodsForRole(role)
          })
          if (leftover.length > 0) {
            dispatcher.feedClient(clientId, leftover)
          }
          accepted.on('data', (chunk: Buffer) => dispatcher.feedClient(clientId, chunk))
        }
      })
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))
  }

  type ClientProbe = {
    sock: Socket
    handshakes: DecodedFrame[]
    responses: JsonRpcResponse[]
    closed: Promise<void>
  }

  async function connectClient(handshake: Buffer): Promise<ClientProbe> {
    const sock = connect(sockPath)
    liveSockets.push(sock)
    const handshakes: DecodedFrame[] = []
    const responses: JsonRpcResponse[] = []
    const decoder = new FrameDecoder((frame) => {
      if (frame.type === MessageType.Handshake) {
        handshakes.push(frame)
        return
      }
      if (frame.type === MessageType.Regular) {
        responses.push(parseJsonRpcMessage(frame.payload) as JsonRpcResponse)
      }
    })
    sock.on('data', (chunk: Buffer) => decoder.feed(chunk))
    const closed = new Promise<void>((r) => sock.once('close', () => r()))
    await new Promise<void>((r) => sock.once('connect', () => r()))
    sock.write(handshake)
    return { sock, handshakes, responses, closed }
  }

  function handshakeFrame(token?: string): Buffer {
    return encodeHandshakeFrame({
      type: 'orca-relay-handshake',
      version: '0.1.0+test',
      ...(token !== undefined ? { token } : {})
    })
  }

  function callVerb(sock: Socket, method: string, id = 1): void {
    sock.write(encodeJsonRpcFrame({ jsonrpc: '2.0', id, method }, id, 0))
  }

  it('refuses a connection that presents no token, before any verb runs', async () => {
    await startDaemon()

    // Pipeline the verb with the handshake: if the gate leaked, the dispatcher
    // would see it in the very same chunk.
    const client = await connectClient(handshakeFrame())
    callVerb(client.sock, 'relay.status')

    await client.closed
    expect(served).toEqual([])
    expect(acceptedRoles).toEqual([])
    expect(client.responses).toEqual([])
    expect(parseHandshakeMessage(client.handshakes[0].payload)).toEqual({
      type: 'orca-relay-handshake-denied',
      reason: 'auth'
    })
  })

  it('refuses a connection presenting a wrong token, before any verb runs', async () => {
    await startDaemon()

    const client = await connectClient(handshakeFrame('b'.repeat(64)))
    callVerb(client.sock, 'relay.status')

    await client.closed
    expect(served).toEqual([])
    expect(acceptedRoles).toEqual([])
    expect(client.responses).toEqual([])
    expect(parseHandshakeMessage(client.handshakes[0].payload)).toMatchObject({
      type: 'orca-relay-handshake-denied'
    })
  })

  it('refuses a token that is a prefix of the real one', async () => {
    await startDaemon()

    const client = await connectClient(handshakeFrame(CONTROL_SECRET.slice(0, 32)))
    callVerb(client.sock, 'relay.status')

    await client.closed
    expect(served).toEqual([])
  })

  it('serves the full verb surface to the control secret', async () => {
    await startDaemon()

    const client = await connectClient(handshakeFrame(CONTROL_SECRET))
    await vi.waitFor(() => expect(client.handshakes).toHaveLength(1))
    expect(parseHandshakeMessage(client.handshakes[0].payload)).toEqual({
      type: 'orca-relay-handshake-ok',
      version: '0.1.0+test',
      auth: 'verified'
    })

    callVerb(client.sock, 'relay.status')
    await vi.waitFor(() => expect(client.responses).toHaveLength(1))
    expect(client.responses[0].result).toEqual({ ok: 'relay.status' })
    expect(served).toEqual(['relay.status'])
    expect(acceptedRoles).toEqual(['control'])
  })

  it('confines the pane CLI secret to orca.cli', async () => {
    await startDaemon()

    const client = await connectClient(handshakeFrame(CLI_SECRET))
    await vi.waitFor(() => expect(client.handshakes).toHaveLength(1))
    expect(acceptedRoles).toEqual(['cli'])

    callVerb(client.sock, 'relay.status', 1)
    await vi.waitFor(() => expect(client.responses).toHaveLength(1))
    expect(client.responses[0].error?.message).toContain('Method not available to this client')
    // Why: a scraped pane env must not become a file/pty capability on the box.
    expect(served).toEqual([])

    callVerb(client.sock, 'orca.cli', 2)
    await vi.waitFor(() => expect(client.responses).toHaveLength(2))
    expect(client.responses[1].result).toEqual({ ok: 'orca.cli' })
    expect(served).toEqual(['orca.cli'])
  })

  it('refuses every client when the daemon was launched without a verifier', async () => {
    server = createServer((sock) => {
      liveSockets.push(sock)
      setupDaemonHandshake(sock, {
        launchVersion: '0.1.0+test',
        auth: { control: '' },
        onAccepted: (_s, _leftover, role) => acceptedRoles.push(role)
      })
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))

    const client = await connectClient(handshakeFrame(CONTROL_SECRET))

    await client.closed
    expect(acceptedRoles).toEqual([])
    expect(parseHandshakeMessage(client.handshakes[0].payload)).toMatchObject({
      type: 'orca-relay-handshake-denied'
    })
  })

  it('checks the credential before the version, so an unauthenticated peer learns nothing', async () => {
    await startDaemon('0.1.0+daemon-version')

    const client = await connectClient(
      encodeHandshakeFrame({ type: 'orca-relay-handshake', version: '0.1.0+other' })
    )

    await client.closed
    const reply = parseHandshakeMessage(client.handshakes[0].payload)
    expect(reply.type).toBe('orca-relay-handshake-denied')
    expect(JSON.stringify(reply)).not.toContain('daemon-version')
  })
})
