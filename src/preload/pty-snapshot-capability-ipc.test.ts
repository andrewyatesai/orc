// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'

// Why through the real bridge: this pins that the exposed PTY API queries the
// capability route with an async `invoke`, never the renderer-parking `sendSync`
// the pre-async version used.

const { exposed, invokeMock, sendSyncMock } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invokeMock: vi.fn(),
  sendSyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed.set(key, value)
    })
  },
  ipcRenderer: {
    on: vi.fn(() => () => {}),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    send: vi.fn(),
    sendSync: sendSyncMock,
    invoke: invokeMock,
    postMessage: vi.fn()
  },
  webFrame: { setZoomFactor: vi.fn(), setZoomLevel: vi.fn(), insertCSS: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

async function loadPreloadPtyApi(): Promise<NonNullable<PreloadApi['pty']>> {
  exposed.clear()
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await vi.resetModules()
  await import('./index')
  await Promise.resolve()
  return (exposed.get('api') as PreloadApi).pty
}

describe('PTY snapshot capability preload IPC', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    sendSyncMock.mockReset()
  })

  it('queries capabilities asynchronously without parking the renderer', async () => {
    const capabilities = [{ id: 'ssh-pty', authoritative: false }]
    // Why channel-keyed: other preload wiring fires its own top-level invoke at
    // module load, so a one-shot mock would be consumed before the test call.
    invokeMock.mockImplementation(async (channel: string) =>
      channel === 'pty:getAuthoritativeBufferSnapshotCapabilities' ? capabilities : undefined
    )
    const pty = await loadPreloadPtyApi()

    await expect(pty.getAuthoritativeBufferSnapshotCapabilities?.(['ssh-pty'])).resolves.toEqual(
      capabilities
    )
    expect(invokeMock).toHaveBeenCalledWith('pty:getAuthoritativeBufferSnapshotCapabilities', {
      ids: ['ssh-pty']
    })
    expect(sendSyncMock).not.toHaveBeenCalledWith(
      'pty:getAuthoritativeBufferSnapshotCapabilitiesSync',
      expect.anything()
    )
  })
})
