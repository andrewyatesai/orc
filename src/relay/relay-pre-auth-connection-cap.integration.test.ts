import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { connect as connectSocket, type Socket } from 'node:net'
import { build } from 'esbuild'
import { relaySyncOnlyWasmGluePlugin } from '../../config/scripts/relay-sync-only-wasm-glue-plugin.mjs'
import {
  spawnRelay,
  TEST_RELAY_AUTH_ARGS,
  TEST_RELAY_SECRET,
  type RelayProcess
} from './subprocess-test-utils'
import { relayTestSocketPath } from './relay-test-socket-path'
import {
  FrameDecoder,
  MessageType,
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  parseHandshakeMessage,
  parseJsonRpcMessage,
  type JsonRpcResponse
} from './protocol'
import {
  MAX_PRE_AUTH_CONNECTIONS,
  PRE_AUTH_HANDSHAKE_TIMEOUT_MS
} from './relay-pre-auth-connection-gate'

// The real daemon, not a stand-in: these assert that the relay a host actually
// deploys refuses to let peers who never authenticate pin its sockets.

const RELAY_TS_ENTRY = path.resolve(__dirname, 'relay.ts')
let bundleDir: string
let relayEntry: string

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'relay-preauth-bundle-'))
  relayEntry = path.join(bundleDir, 'relay.js')
  await build({
    entryPoints: [RELAY_TS_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: relayEntry,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    plugins: [relaySyncOnlyWasmGluePlugin()],
    sourcemap: false
  })
}, 60_000)

afterAll(async () => {
  if (bundleDir) {
    await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('Subprocess: relay pre-auth connection budget', () => {
  let relay: RelayProcess | null = null
  let socketDir: string
  let sockPath: string
  const openSockets: Socket[] = []

  afterEach(async () => {
    for (const s of openSockets) {
      s.destroy()
    }
    openSockets.length = 0
    if (relay && relay.proc.exitCode === null) {
      relay.proc.kill('SIGKILL')
      await relay.waitForExit().catch(() => {})
    }
    relay = null
    if (socketDir) {
      await rm(socketDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  async function startRelay(): Promise<void> {
    socketDir = mkdtempSync(path.join(tmpdir(), 'relay-preauth-sock-'))
    sockPath = relayTestSocketPath(socketDir)
    relay = spawnRelay(relayEntry, [
      '--detached',
      '--grace-time',
      '0',
      ...TEST_RELAY_AUTH_ARGS,
      '--sock-path',
      sockPath,
      '--endpoint-dir',
      path.join(socketDir, 'agent-hooks')
    ])
    await waitForSocketAcceptingConnections()
  }

  async function waitForSocketAcceptingConnections(): Promise<void> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const reached = await new Promise<boolean>((resolve) => {
        const probe = connectSocket(sockPath)
        probe.once('connect', () => {
          probe.destroy()
          resolve(true)
        })
        probe.once('error', () => resolve(false))
      })
      if (reached) {
        return
      }
      if (Date.now() > deadline) {
        throw new Error('relay socket never accepted a connection')
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  type Client = {
    sock: Socket
    closed: Promise<void>
    handshake: Promise<string>
    call: (method: string, id: number) => Promise<JsonRpcResponse>
  }

  function dial(): Client {
    const sock = connectSocket(sockPath)
    openSockets.push(sock)
    // Why: evicted / refused peers reset their client end; that is the behavior
    // under test, not a test failure.
    sock.on('error', () => {})
    let resolveHandshake: (type: string) => void = () => {}
    const handshake = new Promise<string>((r) => {
      resolveHandshake = r
    })
    const responses = new Map<number, (resp: JsonRpcResponse) => void>()
    const decoder = new FrameDecoder((frame) => {
      if (frame.type === MessageType.Handshake) {
        resolveHandshake(parseHandshakeMessage(frame.payload).type)
        return
      }
      if (frame.type === MessageType.Regular) {
        const msg = parseJsonRpcMessage(frame.payload) as JsonRpcResponse
        const waiter = typeof msg.id === 'number' ? responses.get(msg.id) : undefined
        waiter?.(msg)
      }
    })
    sock.on('data', (chunk: Buffer) => decoder.feed(chunk))
    return {
      sock,
      closed: new Promise<void>((r) => sock.once('close', () => r())),
      handshake,
      call: (method, id) =>
        new Promise<JsonRpcResponse>((resolve) => {
          responses.set(id, resolve)
          sock.write(encodeJsonRpcFrame({ jsonrpc: '2.0', id, method }, id, 0))
        })
    }
  }

  async function dialSilent(): Promise<Client> {
    const client = dial()
    await new Promise<void>((r) => client.sock.once('connect', () => r()))
    return client
  }

  async function dialAndAuthenticate(): Promise<Client> {
    const client = await dialSilent()
    client.sock.write(
      encodeHandshakeFrame({
        type: 'orca-relay-handshake',
        // Why: the bundle carries no .version file, so it reports RELAY_VERSION —
        // the same value a client built from this tree computes.
        version: '0.1.0',
        token: TEST_RELAY_SECRET
      })
    )
    expect(await client.handshake).toBe('orca-relay-handshake-ok')
    return client
  }

  // Why a fraction of the deadline: proves the cap shed the socket, not the timer.
  function withinDeadlineFraction(promise: Promise<void>, message: string): Promise<void> {
    return Promise.race([
      promise,
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error(message)), PRE_AUTH_HANDSHAKE_TIMEOUT_MS / 5)
      )
    ])
  }

  async function readSocketStatus(client: Client, id: number): Promise<Record<string, unknown>> {
    const resp = await client.call('relay.status', id)
    expect(resp.error).toBeUndefined()
    return (resp.result as { socket: Record<string, unknown> }).socket
  }

  it('keeps serving an authenticated client while silent peers pile onto the socket', async () => {
    await startRelay()

    // Authenticate first: this client is the one the flood must not displace.
    const legit = await dialAndAuthenticate()
    const before = await readSocketStatus(legit, 1)
    expect(before).toMatchObject({ clients: 1, pendingPreAuth: 0 })

    const silent: Client[] = []
    for (let i = 0; i < MAX_PRE_AUTH_CONNECTIONS + 8; i++) {
      silent.push(await dialSilent())
    }

    // Why the settle: the kernel completes a connect before the daemon accepts
    // it, so an immediate read undercounts the flood. 250ms drains the backlog
    // and is still two orders of magnitude short of the handshake deadline —
    // a budget that holds here held because of the cap, not the timer.
    await new Promise((r) => setTimeout(r, 250))
    const after = await readSocketStatus(legit, 2)
    expect(after.pendingPreAuth as number).toBeLessThanOrEqual(MAX_PRE_AUTH_CONNECTIONS)
    expect(after).toMatchObject({ clients: 1, preAuthLimit: MAX_PRE_AUTH_CONNECTIONS })
    // The shed count survives a flood that would scroll the log clean.
    expect(after.droppedPreAuth as number).toBeGreaterThanOrEqual(8)

    // The earliest silent peers were shed on arrival of the newer ones.
    await Promise.all(
      silent
        .slice(0, 8)
        .map((c) => withinDeadlineFraction(c.closed, 'silent peer was not shed promptly'))
    )

    // And a fresh legitimate dial still authenticates through the flood.
    const late = await dialAndAuthenticate()
    const final = await readSocketStatus(late, 3)
    expect(final).toMatchObject({ clients: 2 })
  }, 60_000)

  it(
    'drops a peer that never sends a handshake, at the real deadline',
    async () => {
      await startRelay()
      // Why: an accepted client cancels the detached startup grace, so the only
      // thing that can close the silent socket is the handshake deadline itself.
      const legit = await dialAndAuthenticate()

      const silent = await dialSilent()
      await new Promise((r) => setTimeout(r, PRE_AUTH_HANDSHAKE_TIMEOUT_MS / 2))
      expect(silent.sock.destroyed).toBe(false)

      await silent.closed
      expect((await readSocketStatus(legit, 1)).pendingPreAuth).toBe(0)
      expect(legit.sock.destroyed).toBe(false)
    },
    PRE_AUTH_HANDSHAKE_TIMEOUT_MS * 3
  )
})
