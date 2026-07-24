import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcEmitter = new EventEmitter()
const ipcMainMock = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.on(channel, listener)
  }),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.removeListener(channel, listener)
  })
}

vi.mock('electron', () => ({
  ipcMain: ipcMainMock
}))

function createMainWindow(webContents: unknown): {
  isDestroyed: () => boolean
  webContents: unknown
  once: (event: string, listener: () => void) => void
} {
  return {
    isDestroyed: () => false,
    webContents,
    once: vi.fn()
  }
}

describe('requestMobileMarkdownFromRenderer', () => {
  beforeEach(() => {
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
    vi.resetModules()
  })

  it('ignores markdown responses from other renderer processes', async () => {
    const { requestMobileMarkdownFromRenderer } = await import('./mobile-markdown-request-relay')
    const mainWebContents = {
      send: vi.fn()
    }
    const otherWebContents = {}
    const mainWindow = createMainWindow(mainWebContents)

    const pending = requestMobileMarkdownFromRenderer(mainWindow as never, {
      operation: 'read',
      worktreeId: 'wt-1',
      tabId: 'tab-md'
    })
    const sentRequest = mainWebContents.send.mock.calls[0]?.[1] as { id: string }

    ipcEmitter.emit(
      'ui:mobileMarkdownResponse',
      { sender: otherWebContents },
      { id: sentRequest.id, ok: false, error: 'wrong_renderer' }
    )
    ipcEmitter.emit(
      'ui:mobileMarkdownResponse',
      { sender: mainWebContents },
      {
        id: sentRequest.id,
        ok: true,
        result: {
          tabId: 'tab-md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          content: '# ok',
          isDirty: false,
          version: 'v1',
          source: 'file',
          editable: true
        }
      }
    )

    await expect(pending).resolves.toMatchObject({ content: '# ok' })
  })

  it('retains a single shared channel listener under concurrent requests and routes by id', async () => {
    const { requestMobileMarkdownFromRenderer } = await import('./mobile-markdown-request-relay')
    const mainWebContents = {
      send: vi.fn()
    }
    const mainWindow = createMainWindow(mainWebContents)

    const pendings = Array.from({ length: 25 }, () =>
      requestMobileMarkdownFromRenderer(mainWindow as never, {
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })
    )

    // Boundary invariant: N concurrent in-flight requests must not accumulate N
    // listeners on the one shared reply channel.
    expect(ipcEmitter.listenerCount('ui:mobileMarkdownResponse')).toBe(1)

    const ids = mainWebContents.send.mock.calls.map((call) => (call[1] as { id: string }).id)
    expect(new Set(ids).size).toBe(25)

    // A response for exactly one id resolves only that promise; the rest stay pending.
    const targetIndex = 7
    ipcEmitter.emit(
      'ui:mobileMarkdownResponse',
      { sender: mainWebContents },
      {
        id: ids[targetIndex],
        ok: true,
        result: {
          tabId: 'tab-md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          content: '# routed',
          isDirty: false,
          version: 'v1',
          source: 'file',
          editable: true
        }
      }
    )

    await expect(pendings[targetIndex]).resolves.toMatchObject({ content: '# routed' })
    // The shared listener is still installed exactly once while others remain pending.
    expect(ipcEmitter.listenerCount('ui:mobileMarkdownResponse')).toBe(1)
  })
})
