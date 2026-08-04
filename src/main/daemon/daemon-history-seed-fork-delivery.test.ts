/* Large cold-restore seeds must still reach a FORK daemon.

   Upstream's chunked history-seed transfer is gated on the public v30 constant, which the fork's
   Rust daemon clears numerically (protocol 10xx) while implementing none of the four transfer RPCs
   (rust/crates/orca-daemon answers "unsupported request type"). The in-repo TS DaemonServer does
   implement them, so this suite makes the server refuse them the way orca-daemon does. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { getHistorySessionDirName } from './history-paths'
import { TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS } from './terminal-history-seed-chunks'
import { FORK_DAEMON_PROTOCOL_NAMESPACE_START, PROTOCOL_VERSION } from './types'
import type { SubprocessHandle } from './session'
import type * as DaemonHealthModule from './daemon-health'
import type * as MacosTccLoginShellModule from '../providers/macos-tcc-login-shell'

const HISTORY_SEED_TRANSFER_REQUESTS = [
  'startHistorySeedTransfer',
  'appendHistorySeedTransfer',
  'finishHistorySeedTransfer',
  'abortHistorySeedTransfer'
]

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return { ...actual, getMacDaemonSystemResolverHealth: vi.fn(async () => 'unknown') }
})

// Why: the fork path awaits the login(1) PAM preflight before building launch config; never
// execFile a real /usr/bin/login from a unit test.
vi.mock('../providers/macos-tcc-login-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof MacosTccLoginShellModule>()
  return { ...actual, prepareMacosTccLoginShell: vi.fn(async () => {}) }
})

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    // Why: getCwd falls back to OS pid lookup; an implausibly-high fake pid can't collide with a real process' cwd.
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(() => setTimeout(() => onExitCb?.(137), 5)),
    signal: vi.fn(),
    onData() {},
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn()
  }
}

function writeUnfinishedSessionCheckpoint(
  historyDir: string,
  sessionId: string,
  snapshotAnsi: string
): void {
  const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
  mkdirSync(sessionDir, { recursive: true })
  const shape = {
    cwd: '/projects/fork-seed',
    cols: 80,
    rows: 24
  }
  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify({ ...shape, startedAt: '2026-07-25T10:00:00Z', endedAt: null, exitCode: null })
  )
  writeFileSync(
    join(sessionDir, 'checkpoint.json'),
    JSON.stringify({
      ...shape,
      snapshotAnsi,
      scrollbackAnsi: '',
      rehydrateSequences: '',
      modes: {
        bracketedPaste: false,
        mouseTracking: false,
        applicationCursor: false,
        alternateScreen: false
      },
      scrollbackLines: 0,
      generation: 0,
      checkpointedAt: '2026-07-25T10:00:00Z'
    })
  )
}

describe('fork-daemon history seed delivery', () => {
  let dir: string
  let historyDir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(async () => {
    // Why the short prefix: the AF_UNIX sun_path cap is 104 bytes on macOS and the fork's
    // daemon-v1021.sock name is already two bytes longer than upstream's.
    dir = mkdtempSync(join(tmpdir(), 'daemon-fork-seed-'))
    historyDir = join(dir, 'history')
    server = new DaemonServer({
      socketPath: getDaemonSocketPath(dir),
      tokenPath: join(dir, 'test.token'),
      log: { log: () => {}, close() {} },
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('seeds a >1MiB cold restore inline when the daemon has no transfer RPCs', async () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(FORK_DAEMON_PROTOCOL_NAMESPACE_START)
    const sessionId = 'fork-large-cold-restore'
    writeUnfinishedSessionCheckpoint(
      historyDir,
      sessionId,
      `${'x'.repeat(TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS + 1)}\r\nFORK-INLINE-SEED-MARKER`
    )
    adapter = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir),
      tokenPath: join(dir, 'test.token'),
      historyPath: historyDir
    })
    const client = (
      adapter as unknown as {
        client: { request: (type: string, payload?: unknown) => Promise<unknown> }
      }
    ).client
    const originalRequest = client.request.bind(client)
    const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (type, payload) => {
      if (HISTORY_SEED_TRANSFER_REQUESTS.includes(type)) {
        throw new Error(`unsupported request type: ${type}`)
      }
      return originalRequest(type, payload)
    })

    const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result.coldRestore?.scrollback).toContain('FORK-INLINE-SEED-MARKER')
    const requestedTypes = requestSpy.mock.calls.map(([type]) => type)
    expect(requestedTypes).not.toContain('startHistorySeedTransfer')
    const createPayload = requestSpy.mock.calls.find(
      ([type]) => type === 'createOrAttach'
    )?.[1] as {
      historySeed?: string
      historySeedTransferId?: string
    }
    expect(createPayload.historySeed).toContain('FORK-INLINE-SEED-MARKER')
    expect(createPayload).not.toHaveProperty('historySeedTransferId')
    // The product fact: the daemon buffer is reseeded, not left renderer-only.
    await expect(adapter.getBufferSnapshot(sessionId)).resolves.toMatchObject({
      data: expect.stringContaining('FORK-INLINE-SEED-MARKER')
    })
  })
})
