import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setupDaemonHandshake } from './relay-handshake'
import { PreAuthConnectionGate } from './relay-pre-auth-connection-gate'
import { encodeHandshakeFrame, FrameDecoder, MessageType, parseHandshakeMessage } from './protocol'
import { relayTestSocketPath } from './relay-test-socket-path'
import { relayAuthVerifier } from '../shared/ssh-relay-auth-token'

// The attack this file is about: authentication decides *whether* a peer gets a
// verb, not how long it may hold a socket. A peer that connects and simply never
// speaks used to keep its socket and fds until the relay died — no verb, no log,
// no UI trace — so enough silent peers exhaust a relay on a machine nobody is
// watching. The deadline and the cap bound what an unauthenticated peer can pin.

const SECRET = 'a'.repeat(64)
const AUTH = { control: relayAuthVerifier(SECRET) }
const VERSION = '0.1.0+test'
// Long enough to survive scheduling noise, short enough that a test can outlive it.
const DEADLINE_MS = 250

describe('pre-auth connection gate', () => {
  let server: Server
  let sockPath: string
  let tmpDir: string
  let liveSockets: Socket[]
  let accepted: Socket[]
  let gate: PreAuthConnectionGate
  let stderrWrite: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-relay-preauth-'))
    sockPath = relayTestSocketPath(tmpDir)
    liveSockets = []
    accepted = []
    stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)
  })

  afterEach(async () => {
    stderrWrite.mockRestore()
    for (const s of liveSockets) {
      s.destroy()
    }
    if (server) {
      await new Promise<void>((r) => server.close(() => r()))
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function startDaemon(options: { limit?: number; timeoutMs?: number } = {}): Promise<void> {
    gate = new PreAuthConnectionGate({ timeoutMs: DEADLINE_MS, ...options })
    server = createServer((sock) => {
      liveSockets.push(sock)
      setupDaemonHandshake(sock, {
        launchVersion: VERSION,
        auth: AUTH,
        preAuth: gate,
        onAccepted: (s) => accepted.push(s)
      })
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))
  }

  type Peer = { sock: Socket; closed: Promise<void>; handshakeOk: Promise<void> }

  function dial(): Peer {
    const sock = connect(sockPath)
    liveSockets.push(sock)
    let resolveOk: () => void = () => {}
    const handshakeOk = new Promise<void>((r) => {
      resolveOk = r
    })
    const decoder = new FrameDecoder((frame) => {
      if (
        frame.type === MessageType.Handshake &&
        parseHandshakeMessage(frame.payload).type === 'orca-relay-handshake-ok'
      ) {
        resolveOk()
      }
    })
    sock.on('data', (chunk: Buffer) => decoder.feed(chunk))
    return {
      sock,
      closed: new Promise<void>((r) => sock.once('close', () => r())),
      handshakeOk
    }
  }

  async function dialAndAuthenticate(): Promise<Peer> {
    const peer = dial()
    await new Promise<void>((r) => peer.sock.once('connect', () => r()))
    peer.sock.write(
      encodeHandshakeFrame({ type: 'orca-relay-handshake', version: VERSION, token: SECRET })
    )
    await peer.handshakeOk
    return peer
  }

  /** Connects and deliberately says nothing — the shape of the pin. */
  async function dialSilent(): Promise<Peer> {
    const peer = dial()
    await new Promise<void>((r) => peer.sock.once('connect', () => r()))
    return peer
  }

  it('drops a connection that never completes the handshake, once the deadline passes', async () => {
    await startDaemon()

    const silent = await dialSilent()
    expect(gate.pendingCount).toBe(1)

    await vi.waitFor(() => expect(gate.pendingCount).toBe(0), { timeout: 2000 })
    await silent.closed
    expect(accepted).toEqual([])
    expect(gate.droppedCount).toBe(1)
  })

  it('leaves an authenticated connection open past the deadline', async () => {
    await startDaemon()

    const peer = await dialAndAuthenticate()
    expect(gate.pendingCount).toBe(0)

    await new Promise((r) => setTimeout(r, DEADLINE_MS * 3))
    expect(peer.sock.destroyed).toBe(false)
    expect(accepted).toHaveLength(1)
    expect(accepted[0].destroyed).toBe(false)
  })

  it('frees a pre-auth slot the moment the peer hangs up, not at the deadline', async () => {
    await startDaemon()

    const silent = await dialSilent()
    expect(gate.pendingCount).toBe(1)
    silent.sock.destroy()

    await vi.waitFor(() => expect(gate.pendingCount).toBe(0))
  })

  it('sheds the longest-waiting silent peer, not the newest arrival', async () => {
    await startDaemon({ limit: 2, timeoutMs: 60_000 })

    const first = await dialSilent()
    const second = await dialSilent()
    expect(gate.pendingCount).toBe(2)

    const third = await dialSilent()
    await first.closed

    expect(gate.pendingCount).toBe(2)
    expect(second.sock.destroyed).toBe(false)
    expect(third.sock.destroyed).toBe(false)
  })

  // Why: shedding the longest-waiting assumes the oldest is the stuck one. Under a
  // legitimate burst — every pane dialing at once after a reconnect — it is simply
  // first in line, so that policy kills a correct handshake to admit another. A peer
  // that has sent bytes is mid-handshake and must outrank a silent one.
  it('sheds a silent peer ahead of one that is mid-handshake, whatever their order', async () => {
    await startDaemon({ limit: 2, timeoutMs: 60_000 })

    // Oldest, and speaking: a partial frame, so the handshake is in flight but unresolved.
    const speaking = await dialSilent()
    speaking.sock.write(Buffer.from([0x00]))
    await vi.waitFor(() => expect(gate.pendingCount).toBe(1))

    const silent = await dialSilent()
    expect(gate.pendingCount).toBe(2)

    // At the cap: the silent peer goes, even though the speaker arrived first.
    const third = await dialSilent()
    await silent.closed

    expect(speaking.sock.destroyed).toBe(false)
    expect(third.sock.destroyed).toBe(false)
  })

  it('serves a legitimate client while silent peers try to fill the socket table', async () => {
    // Why timeoutMs high: this must prove the *cap* admits the honest peer, not
    // that a deadline happened to free a slot in time.
    await startDaemon({ limit: 4, timeoutMs: 60_000 })
    // Why: a real relay starves at its fd ceiling, which a test cannot reach —
    // maxConnections is that ceiling in miniature. Uncapped, the silent peers
    // fill it and the honest dial is refused before it can say a word.
    server.maxConnections = 8

    for (let i = 0; i < 24; i++) {
      await dialSilent()
      expect(gate.pendingCount).toBeLessThanOrEqual(4)
    }

    const honest = await dialAndAuthenticate()
    expect(accepted).toHaveLength(1)
    expect(honest.sock.destroyed).toBe(false)
  })

  it('does not count authenticated clients against the cap', async () => {
    // A legitimate host runs many panes; the DoS control must never throttle them.
    await startDaemon({ limit: 2, timeoutMs: 60_000 })

    const peers: Peer[] = []
    for (let i = 0; i < 8; i++) {
      peers.push(await dialAndAuthenticate())
    }

    expect(gate.pendingCount).toBe(0)
    expect(accepted).toHaveLength(8)
    expect(peers.every((p) => !p.sock.destroyed)).toBe(true)
  })
})
