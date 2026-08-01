/**
 * `terminal.await` at the wire: it is a long poll and must be metered as one —
 * it holds the socket open like `terminal.wait`, so it needs the same
 * keepalive, the same LONG_POLL_CAP slot, and the same release when the caller
 * disconnects. Plus the admission checks that keep a bad watch set from turning
 * into a silent forever-poll.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const WORKTREE_ID = 'repo-1::/tmp/worktree-a'

function sendRequest(
  endpoint: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      socket.end()
      resolve(JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

function runtimeWithLivePane(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Terminal 1',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId: 'pty-1'
      }
    ]
  })
  return runtime
}

describe('terminal.await long-poll metering', () => {
  it('holds a long-poll slot while parked and frees it when the caller disconnects', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-terminal-await-'))
    const runtime = runtimeWithLivePane()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 1_000,
      longPollCap: 1
    })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)!
      const endpoint = metadata.transports[0]!.endpoint
      const listed = await sendRequest(endpoint, {
        id: 'req_list',
        authToken: metadata.authToken,
        method: 'terminal.list'
      })
      const handle = (listed.result as { terminals: { handle: string }[] }).terminals[0]!.handle

      const socket = createConnection(endpoint)
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(
          `${JSON.stringify({
            id: 'req_await',
            authToken: metadata.authToken,
            method: 'terminal.await',
            params: { terminals: [{ terminal: handle }], timeoutMs: 30_000 }
          })}\n`
        )
      })

      await waitFor(() => server['activeLongPolls'] === 1)
      socket.destroy()
      await waitFor(() => server['activeLongPolls'] === 0)

      // The freed slot admits the next long poll instead of runtime_busy.
      const admitted = await sendRequest(endpoint, {
        id: 'req_await_2',
        authToken: metadata.authToken,
        method: 'terminal.await',
        params: { terminals: [{ terminal: handle }], timeoutMs: 20 }
      })
      expect(admitted).toMatchObject({ ok: true, result: { await: { outcome: 'timeout' } } })
    } finally {
      await server.stop()
    }
  })

  it('rejects a watch set that cannot be served rather than polling forever', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-terminal-await-'))
    const runtime = runtimeWithLivePane()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)!
      const endpoint = metadata.transports[0]!.endpoint
      const listed = await sendRequest(endpoint, {
        id: 'req_list',
        authToken: metadata.authToken,
        method: 'terminal.list'
      })
      const handle = (listed.result as { terminals: { handle: string }[] }).terminals[0]!.handle

      const response = await sendRequest(endpoint, {
        id: 'req_await_dup',
        authToken: metadata.authToken,
        method: 'terminal.await',
        params: { terminals: [{ terminal: handle }, { terminal: handle }], timeoutMs: 20 }
      })

      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })

      // A predicate the journal can never satisfy fails loudly, not by hanging.
      const unknownKind = await sendRequest(endpoint, {
        id: 'req_await_kind',
        authToken: metadata.authToken,
        method: 'terminal.await',
        params: { terminals: [{ terminal: handle }], kinds: ['title'], timeoutMs: 20 }
      })

      expect(unknownKind).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })

      // A kind that is real, but that nothing in this posture can emit, is
      // answered — never parked out into a timeout that reads as "not yet".
      const unproducible = await sendRequest(endpoint, {
        id: 'req_await_bell',
        authToken: metadata.authToken,
        method: 'terminal.await',
        params: { terminals: [{ terminal: handle }], kinds: ['bell'], timeoutMs: 20 }
      })

      expect(unproducible).toMatchObject({
        ok: true,
        result: {
          await: { outcome: 'unsupported', kinds: ['bell'], reason: 'no-side-effect-consumer' }
        }
      })
    } finally {
      await server.stop()
    }
  })
})
