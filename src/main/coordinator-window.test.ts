import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COORDINATOR_TUNNEL_REQUEST_CHANNEL,
  type CoordinatorTunnelRequest
} from '../shared/coordinator-daemon-tunnel'

// Shared capture state so the test can reach the electron/net mocks the module
// wires up at import time. Reset in beforeEach; the module is re-imported fresh
// per test (vi.resetModules) so its module-level socket map starts empty.
const h = vi.hoisted(() => ({
  state: {
    ipcHandlers: new Map<string, (...args: unknown[]) => void>(),
    window: null as null | {
      webContentsListeners: Map<string, (...args: unknown[]) => void>
      windowListeners: Map<string, (...args: unknown[]) => void>
      webContents: { id: number; send: ReturnType<typeof vi.fn> }
    },
    sockets: [] as { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[]
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function BrowserWindowMock() {
    const webContentsListeners = new Map<string, (...args: unknown[]) => void>()
    const windowListeners = new Map<string, (...args: unknown[]) => void>()
    const win = {
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        id: 42,
        on: (event: string, cb: (...args: unknown[]) => void) => {
          webContentsListeners.set(event, cb)
        },
        send: vi.fn()
      },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        windowListeners.set(event, cb)
      },
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      webContentsListeners,
      windowListeners
    }
    h.state.window = win
    return win
  }),
  ipcMain: {
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      h.state.ipcHandlers.set(channel, cb)
    }
  },
  nativeTheme: { shouldUseDarkColors: false }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => {
    const socket = {
      once: vi.fn(),
      on: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
      connecting: true
    }
    h.state.sockets.push(socket)
    return socket
  })
}))

vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => 'test-token\n') }))
vi.mock('./daemon/daemon-init', () => ({
  getDaemonEndpointPaths: vi.fn(() => ({ socketPath: '/tmp/daemon.sock', tokenPath: '/tmp/token' }))
}))
vi.mock('./daemon/types', () => ({ PROTOCOL_VERSION: 1 }))

const TRUSTED_SENDER = { sender: { id: 42 } }

function drive(message: CoordinatorTunnelRequest, event: unknown = TRUSTED_SENDER): void {
  const handler = h.state.ipcHandlers.get(COORDINATOR_TUNNEL_REQUEST_CHANNEL)
  if (!handler) {
    throw new Error('tunnel request handler not registered')
  }
  handler(event, message)
}

async function openWindowAndTwoSockets(): Promise<void> {
  const mod = await import('./coordinator-window')
  mod.openCoordinatorWindow()
  drive({ op: 'open', socketId: 1 })
  drive({ op: 'open', socketId: 2 })
  expect(h.state.sockets).toHaveLength(2)
}

beforeEach(() => {
  vi.resetModules()
  h.state.ipcHandlers.clear()
  h.state.window = null
  h.state.sockets.length = 0
})

describe('coordinator tunnel socket teardown on renderer reset', () => {
  it('destroys all tunnel sockets when the renderer process is gone (reload/crash reuses the WebContents)', async () => {
    await openWindowAndTwoSockets()

    const onRendererGone = h.state.window?.webContentsListeners.get('render-process-gone')
    expect(onRendererGone, 'render-process-gone teardown must be registered').toBeTypeOf('function')
    onRendererGone?.()

    expect(h.state.sockets[0].destroy).toHaveBeenCalled()
    expect(h.state.sockets[1].destroy).toHaveBeenCalled()
    // Map is cleared: a later data op for a torn-down socketId must not write.
    drive({ op: 'data', socketId: 1, data: 'x' })
    expect(h.state.sockets[0].write).not.toHaveBeenCalled()
  })

  it('destroys tunnel sockets on a main-frame reload before the new page reopens its own', async () => {
    await openWindowAndTwoSockets()

    const onNav = h.state.window?.webContentsListeners.get('did-start-navigation')
    expect(onNav, 'did-start-navigation teardown must be registered').toBeTypeOf('function')
    // (event, url, isInPlace, isMainFrame) — a reload is main-frame, not in-place.
    onNav?.({}, 'https://coordinator/', false, true)

    expect(h.state.sockets[0].destroy).toHaveBeenCalled()
    expect(h.state.sockets[1].destroy).toHaveBeenCalled()
  })

  it('does not tear down the tunnel on an in-page (hash) navigation', async () => {
    await openWindowAndTwoSockets()

    const onNav = h.state.window?.webContentsListeners.get('did-start-navigation')
    onNav?.({}, 'https://coordinator/#panel', true, true)

    expect(h.state.sockets[0].destroy).not.toHaveBeenCalled()
    expect(h.state.sockets[1].destroy).not.toHaveBeenCalled()
  })

  it('ignores tunnel requests from an untrusted sender (boundary stays fail-closed)', async () => {
    const mod = await import('./coordinator-window')
    mod.openCoordinatorWindow()
    drive({ op: 'open', socketId: 9 }, { sender: { id: 999 } })
    expect(h.state.sockets).toHaveLength(0)
  })
})
