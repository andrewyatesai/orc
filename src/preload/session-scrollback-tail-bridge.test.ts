// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_SCROLLBACK_TAIL_PREFETCH_CHANNEL } from './terminal-scrollback-tail-prefetch'

// Why through the real bridge: this pins that the exposed session API actually
// consumes the prefetch, rather than the reader being wired up but unused.

type TailRead = {
  text: string
  olderChunkCursor: number
  olderEndOffset: number
  fingerprint: string
}

const { exposed, invokeMock, sendSyncMock, prefetchPayload } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invokeMock: vi.fn(),
  sendSyncMock: vi.fn(),
  prefetchPayload: { value: null as unknown }
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

function tail(text: string): TailRead {
  return { text, olderChunkCursor: 0, olderEndOffset: 4096, fingerprint: '4096:11' }
}

type SessionApi = {
  readTerminalScrollbackTail: (args: { ref: string }) => TailRead | null
  setSync: (args: unknown) => void
}

async function loadPreloadSessionApi(): Promise<SessionApi> {
  exposed.clear()
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await vi.resetModules()
  await import('./index')
  // Let the prefetch promise settle before any pane reads.
  await Promise.resolve()
  await Promise.resolve()
  return (exposed.get('api') as { session: SessionApi }).session
}

describe('preload session.readTerminalScrollbackTail', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    sendSyncMock.mockReset()
    prefetchPayload.value = null
    invokeMock.mockImplementation(async (channel: string) =>
      channel === TERMINAL_SCROLLBACK_TAIL_PREFETCH_CHANNEL ? prefetchPayload.value : undefined
    )
    sendSyncMock.mockImplementation((_channel: string, args: { ref?: string }) =>
      args?.ref === 'v1-a' ? tail('bytes from the blocking read') : null
    )
  })

  it('answers a restored pane from the prefetch without a blocking read', async () => {
    prefetchPayload.value = { 'v1-a': tail('bytes from the prefetch') }
    const session = await loadPreloadSessionApi()

    expect(invokeMock).toHaveBeenCalledWith(TERMINAL_SCROLLBACK_TAIL_PREFETCH_CHANNEL)
    expect(session.readTerminalScrollbackTail({ ref: 'v1-a' })).toEqual(
      tail('bytes from the prefetch')
    )
    expect(sendSyncMock).not.toHaveBeenCalled()

    // Consumed once — a remount re-reads from disk instead of replaying the copy.
    expect(session.readTerminalScrollbackTail({ ref: 'v1-a' })?.text).toBe(
      'bytes from the blocking read'
    )
    expect(sendSyncMock).toHaveBeenCalledWith('session:read-terminal-scrollback-tail-sync', {
      ref: 'v1-a'
    })
  })

  it('falls back to the sync channel when nothing was prefetched', async () => {
    prefetchPayload.value = {}
    const session = await loadPreloadSessionApi()

    expect(session.readTerminalScrollbackTail({ ref: 'v1-a' })?.text).toBe(
      'bytes from the blocking read'
    )
    expect(session.readTerminalScrollbackTail({ ref: 'v1-missing' })).toBeNull()
  })

  it('drops the prefetch when a buffer-carrying session save is forwarded', async () => {
    prefetchPayload.value = { 'v1-a': tail('bytes from the prefetch') }
    const session = await loadPreloadSessionApi()

    session.setSync({
      terminalLayoutsByTabId: { 'tab-1': { buffersByLeafId: { 'leaf-a': 'captured at quit' } } }
    })

    expect(session.readTerminalScrollbackTail({ ref: 'v1-a' })?.text).toBe(
      'bytes from the blocking read'
    )
  })
})
