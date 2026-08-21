import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// STA-517: the runtime's worktree.ps liveness refresh calls the aggregate PTY inventory under a
// 3s budget, and only a returned inventory can retire an exited PTY. One unreachable relay used to
// reject the whole Promise.all, so no PTY was ever proven dead and every retained pane — the SSH
// ones above all — kept reporting "active" to mobile for as long as the connection stayed down.
// This exercises the pty.ts seam the runtime drives: a rejecting relay drops out, a silent relay is
// bounded by the caller's deadline instead of the mux's 30s default, and a local fault still fails.

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/orca-test-userdata')
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  },
  powerMonitor: {
    on: vi.fn()
  }
}))

vi.mock('fs', () => ({
  existsSync: () => true,
  statSync: () => ({ isDirectory: () => true, mode: 0o755 }),
  accessSync: () => undefined,
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    pid: 12345
  })
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import {
  killAllPty,
  registerPtyHandlers,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'
import { _resetLocalPtyProviderStateForTest } from '../providers/local-pty-provider'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'

type ListOpts = { deadlineMs?: number } | undefined

function createProvider(
  sessions: PtyProcessInfo[],
  behavior: 'ok' | 'reject' = 'ok'
): { provider: IPtyProvider; calls: ListOpts[] } {
  const calls: ListOpts[] = []
  const provider = {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    getForegroundProcess: vi.fn(async () => null),
    listProcesses: vi.fn(async (opts?: { deadlineMs?: number }) => {
      calls.push(opts)
      if (behavior === 'reject') {
        throw new Error('relay unreachable')
      }
      return sessions
    })
  } as unknown as IPtyProvider
  return { provider, calls }
}

function session(id: string): PtyProcessInfo {
  return { id, cwd: '/tmp', title: id } as unknown as PtyProcessInfo
}

type InventoryController = {
  listProcesses: (opts?: { deadlineMs?: number }) => Promise<PtyProcessInfo[]>
  listProcessesWithHostScope: (opts?: { deadlineMs?: number }) => Promise<{
    processes: PtyProcessInfo[]
    hostIds: string[]
  }>
}

const mainWindow = {
  isDestroyed: () => false,
  webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
}

function captureController(): InventoryController {
  const runtime = { setPtyController: vi.fn() }
  registerPtyHandlers(mainWindow as never, runtime as never)
  const controller = runtime.setPtyController.mock.calls[0]?.[0] as InventoryController | undefined
  if (typeof controller?.listProcesses !== 'function') {
    throw new Error('PTY controller listProcesses was not registered')
  }
  return controller
}

describe('aggregate PTY inventory against a partially answering relay set', () => {
  const registered: string[] = []

  function register(connectionId: string, provider: IPtyProvider): void {
    registerSshPtyProvider(connectionId, provider)
    registered.push(connectionId)
  }

  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    handleMock.mockImplementation(() => {})
    onMock.mockImplementation(() => {})
  })

  afterEach(() => {
    for (const connectionId of registered.splice(0)) {
      unregisterSshPtyProvider(connectionId)
    }
    killAllPty()
    _resetLocalPtyProviderStateForTest()
  })

  it('still reports local and healthy relays when one SSH relay rejects', async () => {
    const local = createProvider([session('local-pty')])
    const healthy = createProvider([session('ssh:conn-ok@@pty')])
    const broken = createProvider([], 'reject')
    setLocalPtyProvider(local.provider)
    register('conn-ok', healthy.provider)
    register('conn-broken', broken.provider)
    const controller = captureController()

    const sessions = await controller.listProcesses()

    // Pre-fix this rejected: the plain Promise.all surfaced the broken relay's error, the runtime
    // read it as "no inventory", and no PTY anywhere was retired.
    expect(sessions.map((entry) => entry.id).sort()).toEqual(['local-pty', 'ssh:conn-ok@@pty'])
  })

  it('drops the unreachable host from the scope so its panes are never proven dead', async () => {
    const local = createProvider([session('local-pty')])
    const broken = createProvider([], 'reject')
    setLocalPtyProvider(local.provider)
    register('conn-broken', broken.provider)
    const controller = captureController()

    const { hostIds } = await controller.listProcessesWithHostScope()

    // A provider that did not answer is unknown, not empty: absent from hostIds it lands in the
    // runtime's omittedHostIds, so its retained PTYs stay live instead of being retired.
    expect(hostIds).not.toContain('ssh:conn-broken')
    expect(hostIds).toContain('local')
  })

  it('bounds every relay list by the caller deadline instead of the mux default', async () => {
    const local = createProvider([session('local-pty')])
    const remote = createProvider([session('ssh:conn-a@@pty')])
    setLocalPtyProvider(local.provider)
    register('conn-a', remote.provider)
    const controller = captureController()
    const deadlineMs = Date.now() + 2500

    await controller.listProcesses({ deadlineMs })

    // Without a forwarded deadline an unanswered relay list runs to the SSH mux's own 30s default,
    // far past the runtime's 3s budget for the whole refresh.
    expect(remote.calls).toEqual([{ deadlineMs }])
    // The local provider answers in-process, so the relay deadline must not be forced onto it.
    expect(local.calls).toEqual([undefined])
  })

  it('fails the aggregate when the local provider cannot list', async () => {
    const local = createProvider([], 'reject')
    setLocalPtyProvider(local.provider)
    const controller = captureController()

    // A local failure is a real controller fault, not one unreachable host: the runtime must keep
    // treating it as "no inventory" rather than proving every local PTY dead.
    await expect(controller.listProcesses()).rejects.toThrow('relay unreachable')
  })
})
