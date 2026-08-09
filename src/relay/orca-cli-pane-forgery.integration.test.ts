/**
 * End-to-end pane forgery test against a REAL relay daemon process.
 *
 * Real here: the built relay bundle running as its own process, the real Unix
 * socket, the real authenticated handshake and role gate for both the host
 * (control) and pane (cli) connections, real node-pty panes, and real
 * environment inheritance into those panes. Nothing about attribution is
 * stubbed — the pane token is read the way the in-pane `orca` shim reads it, by
 * asking the pane's own shell to print its environment.
 *
 * Not covered: a real SSH hop. Both connections here are the ones production
 * uses — the host arrives through `relay.js --connect`'s socket, the pane
 * through `relay.js --orca-cli`'s — so only the transport under them is local.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FrameDecoder,
  MessageType,
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  parseHandshakeMessage,
  parseJsonRpcMessage,
  type DecodedFrame,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './protocol'
import { relayTestSocketPath } from './relay-test-socket-path'
import {
  deriveRelayCliSecret,
  mintRelayAuthSecret,
  relayAuthVerifier
} from '../shared/ssh-relay-auth-token'

const REPO_ROOT = join(__dirname, '..', '..')
const RELAY_DIR = join(REPO_ROOT, 'out', 'relay', `${process.platform}-${process.arch}`)
const RELAY_JS = join(RELAY_DIR, 'relay.js')

const CONTROL_SECRET = mintRelayAuthSecret()
const CLI_SECRET = deriveRelayCliSecret(CONTROL_SECRET)

const PANE_A = {
  ORCA_PANE_KEY: 'tab-a:leaf-a',
  ORCA_TERMINAL_HANDLE: 'term_a',
  ORCA_TAB_ID: 'tab-a'
}
const PANE_B = {
  ORCA_PANE_KEY: 'tab-b:leaf-b',
  ORCA_TERMINAL_HANDLE: 'term_b',
  ORCA_TAB_ID: 'tab-b'
}

/** One authenticated socket client — the host uses the control secret, a pane the cli one. */
class RelayClient {
  private nextSeq = 1
  private highestReceivedSeq = 0
  private nextRequestId = 1
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>()
  readonly responses: JsonRpcResponse[] = []
  readonly notifications: { method: string; params: Record<string, unknown> }[] = []
  readonly inboundRequests: JsonRpcRequest[] = []
  private readonly decoder: FrameDecoder

  private constructor(
    private readonly sock: Socket,
    onHandshake: (accepted: boolean) => void
  ) {
    this.decoder = new FrameDecoder((frame: DecodedFrame) => {
      if (frame.id > this.highestReceivedSeq) {
        this.highestReceivedSeq = frame.id
      }
      if (frame.type === MessageType.Handshake) {
        onHandshake(parseHandshakeMessage(frame.payload).type === 'orca-relay-handshake-ok')
        return
      }
      if (frame.type === MessageType.Regular) {
        this.onMessage(parseJsonRpcMessage(frame.payload))
      }
    })
    sock.on('data', (chunk: Buffer) => this.decoder.feed(chunk))
  }

  static async connect(sockPath: string, version: string, token: string): Promise<RelayClient> {
    const sock = connect(sockPath)
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })
    let settle: (accepted: boolean) => void = () => {}
    const handshaken = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    const client = new RelayClient(sock, settle)
    sock.write(encodeHandshakeFrame({ type: 'orca-relay-handshake', version, token }))
    if (!(await handshaken)) {
      throw new Error('relay refused the handshake')
    }
    return client
  }

  private onMessage(msg: ReturnType<typeof parseJsonRpcMessage>): void {
    if ('id' in msg && 'method' in msg) {
      this.inboundRequests.push(msg as JsonRpcRequest)
      return
    }
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const response = msg as JsonRpcResponse
      this.responses.push(response)
      this.pending.get(response.id)?.(response)
      this.pending.delete(response.id)
      return
    }
    const notification = msg as { method: string; params?: Record<string, unknown> }
    this.notifications.push({ method: notification.method, params: notification.params ?? {} })
  }

  private write(msg: Record<string, unknown>): void {
    this.sock.write(encodeJsonRpcFrame(msg as never, this.nextSeq++, this.highestReceivedSeq))
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextRequestId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Fire-and-forget request: the pane shim never waits on a JS promise. */
  send(id: number, method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', id, method, params })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  destroy(): void {
    this.sock.destroy()
  }
}

async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe.skipIf(process.platform === 'win32')('orca.cli pane forgery against a live relay', () => {
  let tmpDir: string
  let child: ChildProcessWithoutNullStreams | null = null
  let host: RelayClient
  let clients: RelayClient[] = []
  let sockPath: string
  let launchVersion: string

  beforeAll(() => {
    // Why: run this checkout's relay, not whatever bundle out/ was left holding.
    execFileSync(process.execPath, [join(REPO_ROOT, 'config', 'scripts', 'build-relay.mjs')], {
      cwd: REPO_ROOT,
      stdio: 'pipe'
    })
    expect(existsSync(RELAY_JS)).toBe(true)
    launchVersion = readFileSync(join(RELAY_DIR, '.version'), 'utf8').trim()
  })

  afterEach(() => {
    for (const client of clients) {
      client.destroy()
    }
    clients = []
    child?.kill('SIGKILL')
    child = null
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function startRelay(): Promise<void> {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-relay-cli-'))
    sockPath = relayTestSocketPath(tmpDir)
    child = spawn(
      process.execPath,
      [
        RELAY_JS,
        '--sock-path',
        sockPath,
        '--auth-verifier',
        relayAuthVerifier(CONTROL_SECRET),
        '--cli-auth-verifier',
        relayAuthVerifier(CLI_SECRET),
        // Why: 0 disables the grace shutdown timer, so the daemon stays up for
        // the whole test instead of reaping itself between connections.
        '--grace-time',
        '0'
      ],
      { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    child.stdout.resume()
    child.stderr.resume()
    await waitFor(() => (existsSync(sockPath) ? true : undefined), 'the relay socket')
    host = await connectAs(CONTROL_SECRET)
  }

  async function connectAs(secret: string): Promise<RelayClient> {
    const client = await RelayClient.connect(sockPath, launchVersion, secret)
    clients.push(client)
    return client
  }

  /** Spawns a real pane, then reads its token the way the in-pane shim does. */
  async function spawnPane(
    identityEnv: Record<string, string>,
    worktreePath: string
  ): Promise<{ id: string; paneToken: string }> {
    mkdirSync(worktreePath, { recursive: true })
    const response = await host.request('pty.spawn', {
      cwd: worktreePath,
      cols: 80,
      rows: 24,
      shellOverride: '/bin/sh',
      env: {
        ...identityEnv,
        ORCA_WORKTREE_ID: `repo::${worktreePath}`,
        ORCA_WORKSPACE_ID: `repo::${worktreePath}`,
        PS1: ''
      }
    })
    expect(response.error).toBeUndefined()
    const id = (response.result as { id: string }).id

    const marker = `PANE_TOKEN_${identityEnv.ORCA_TAB_ID}`
    host.notify('pty.data', {
      id,
      data: `printf '${marker}[%s]\\n' "$ORCA_RELAY_PANE_TOKEN"\n`
    })
    const paneToken = await waitFor(() => {
      const output = host.notifications
        .filter((n) => n.method === 'pty.data' && n.params.id === id)
        .map((n) => String(n.params.data ?? ''))
        .join('')
      // The echoed command line contains the variable name, not its value, so
      // only the printed line can match this.
      return output.match(new RegExp(`${marker}\\[([0-9a-f]{64})\\]`))?.[1]
    }, `pane ${id} to print its token`)
    return { id, paneToken }
  }

  function forwardedOrcaCli(): JsonRpcRequest | undefined {
    return host.inboundRequests.find((request) => request.method === 'orca.cli')
  }

  it('gives a pane its own identity and refuses the one it claims', async () => {
    await startRelay()
    const paneA = await spawnPane(PANE_A, join(tmpDir, 'wt-a'))
    await spawnPane(PANE_B, join(tmpDir, 'wt-b'))

    // Pane A's shim, presenting pane A's real token while claiming to be pane B
    // in pane B's worktree — the environ-scrape attack, verbatim.
    const pane = await connectAs(CLI_SECRET)
    pane.send(1, 'orca.cli', {
      argv: ['terminal', 'send', '--worktree', 'active', '--text', 'rm -rf .'],
      cwd: join(tmpDir, 'wt-b'),
      env: {
        ...PANE_B,
        ORCA_WORKTREE_ID: `repo::${join(tmpDir, 'wt-b')}`,
        ORCA_WORKSPACE_ID: `repo::${join(tmpDir, 'wt-b')}`
      },
      paneToken: paneA.paneToken
    })

    const forwarded = await waitFor(forwardedOrcaCli, 'the relay to forward orca.cli to the host')
    const params = forwarded.params as Record<string, unknown>

    expect(params.identity).toEqual({
      paneKey: PANE_A.ORCA_PANE_KEY,
      terminalHandle: PANE_A.ORCA_TERMINAL_HANDLE,
      worktreeId: `repo::${join(tmpDir, 'wt-a')}`,
      workspaceId: `repo::${join(tmpDir, 'wt-a')}`
    })
    // Nothing the caller wrote may reach the host as identity.
    expect(params.env).not.toHaveProperty('ORCA_PANE_KEY')
    expect(params.env).not.toHaveProperty('ORCA_WORKTREE_ID')
    expect(params.env).not.toHaveProperty('ORCA_TERMINAL_HANDLE')
    expect(params.env).not.toHaveProperty('ORCA_WORKSPACE_ID')
    expect(params).not.toHaveProperty('paneToken')

    // And the legitimate part of the call still completes end to end.
    host.respond(forwarded.id, { stdout: 'ok\n', stderr: '', exitCode: 0 })
    const response = await waitFor(
      () => pane.responses.find((r) => r.id === 1),
      'the CLI response to reach the pane'
    )
    expect(response.result).toEqual({ stdout: 'ok\n', stderr: '', exitCode: 0 })
  })

  it('attributes each pane to itself, so a legitimate call keeps working', async () => {
    await startRelay()
    const paneB = await spawnPane(PANE_B, join(tmpDir, 'wt-b'))

    const pane = await connectAs(CLI_SECRET)
    pane.send(1, 'orca.cli', {
      argv: ['status', '--json'],
      cwd: join(tmpDir, 'wt-b', 'src'),
      env: { PATH: '/usr/bin' },
      paneToken: paneB.paneToken
    })

    const forwarded = await waitFor(forwardedOrcaCli, 'the relay to forward orca.cli to the host')
    expect((forwarded.params as Record<string, unknown>).identity).toMatchObject({
      paneKey: PANE_B.ORCA_PANE_KEY,
      worktreeId: `repo::${join(tmpDir, 'wt-b')}`
    })
  })

  it('gives a caller with no pane token no identity to act under', async () => {
    await startRelay()
    await spawnPane(PANE_A, join(tmpDir, 'wt-a'))

    const pane = await connectAs(CLI_SECRET)
    pane.send(1, 'orca.cli', {
      argv: ['status'],
      cwd: join(tmpDir, 'wt-a'),
      env: { ...PANE_A, ORCA_WORKTREE_ID: `repo::${join(tmpDir, 'wt-a')}` }
    })

    const forwarded = await waitFor(forwardedOrcaCli, 'the relay to forward orca.cli to the host')
    expect((forwarded.params as Record<string, unknown>).identity).toEqual({})
  })

  it('stops honoring a pane token once that pane is gone', async () => {
    await startRelay()
    const paneA = await spawnPane(PANE_A, join(tmpDir, 'wt-a'))

    const shutdown = await host.request('pty.shutdown', { id: paneA.id, immediate: true })
    expect(shutdown.error).toBeUndefined()
    await waitFor(
      () => (host.notifications.some((n) => n.method === 'pty.exit') ? true : undefined),
      'the pane to exit'
    )

    const pane = await connectAs(CLI_SECRET)
    pane.send(1, 'orca.cli', { argv: ['status'], cwd: '/', env: {}, paneToken: paneA.paneToken })

    const forwarded = await waitFor(forwardedOrcaCli, 'the relay to forward orca.cli to the host')
    expect((forwarded.params as Record<string, unknown>).identity).toEqual({})
  })
})
