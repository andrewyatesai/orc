import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why this file exists: upstream #13260 stopped calling ensureWslHookRelayForReattach from the WSL
// benchmark and instead reattached a surviving PTY through main's real spawn path, so a removed or
// misplaced integration in pty.ts fails the bench. That bench is WSL-only and cannot run here; this
// vitest proves the same reachability at the seam — registerPtyHandlers' spawn path must drive
// wslHookRelayManager.ensureForDistro for a reattach, and must not for a fresh spawn.

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

import { killAllPty, registerPtyHandlers, setLocalPtyProvider } from './pty'
import { _resetLocalPtyProviderStateForTest } from '../providers/local-pty-provider'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import type { IPtyProvider } from '../providers/types'

const SURVIVING_DISTRO = 'Ubuntu-24.04'

describe('registerPtyHandlers WSL hook-relay reattach seam', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
  }
  let ensureForDistro: ReturnType<typeof vi.spyOn>

  /** A minimal reattach-reporting provider — the spawn result's wslDistro is what the reattach
   *  helper reads, so a plain object is enough to exercise the pty.ts integration. */
  function reattachProvider(result: Record<string, unknown>): IPtyProvider {
    return {
      spawn: vi.fn(async () => result),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    onMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    onMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    // Spy, so the real relay body (guest process spawn) never runs; we only observe the call site.
    ensureForDistro = vi.spyOn(wslHookRelayManager, 'ensureForDistro').mockImplementation(() => {})
  })

  afterEach(() => {
    killAllPty()
    _resetLocalPtyProviderStateForTest()
    ensureForDistro.mockRestore()
  })

  it('refreshes the relay for the surviving distro when pty:spawn reports a reattach', async () => {
    setLocalPtyProvider(
      reattachProvider({ id: 'pty-restored', isReattach: true, wslDistro: SURVIVING_DISTRO })
    )
    registerPtyHandlers(mainWindow as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    // The reachability guard: if pty.ts drops or misplaces ensureWslHookRelayForReattach on the
    // spawn path, the surviving PTY reattaches without ever re-pointing the relay endpoint.
    expect(ensureForDistro).toHaveBeenCalledTimes(1)
    expect(ensureForDistro).toHaveBeenCalledWith(SURVIVING_DISTRO)
  })

  it('does not refresh the relay for a fresh (non-reattach) spawn', async () => {
    // Why: mirrors the bench "Fresh WSL spawn refreshed the relay" guard — a fresh spawn resolving
    // its own distro must not false-green the reattach refresh count.
    setLocalPtyProvider(reattachProvider({ id: 'pty-fresh', wslDistro: SURVIVING_DISTRO }))
    registerPtyHandlers(mainWindow as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(ensureForDistro).not.toHaveBeenCalled()
  })

  it('drives the relay refresh through the runtime PTY controller reattach path too', async () => {
    // Why: main installs a second spawn site via runtime.setPtyController (the orca CLI / automation
    // path the bench drives); it carries its own ensureWslHookRelayForReattach call.
    type RuntimeSpawnController = { spawn(args: unknown): Promise<{ id: string }> }
    setLocalPtyProvider(
      reattachProvider({ id: 'pty-restored', isReattach: true, wslDistro: SURVIVING_DISTRO })
    )
    const runtime = { setPtyController: vi.fn() }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as RuntimeSpawnController
    expect(typeof controller?.spawn).toBe('function')

    await controller.spawn({ cols: 80, rows: 24, env: {} })

    expect(ensureForDistro).toHaveBeenCalledWith(SURVIVING_DISTRO)
  })
})
