import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  clipboardBuffer,
  clipboardReadText,
  clipboardWriteText,
  clipboardReadImage,
  clipboardWriteImage,
  clipboardWriteBuffer,
  isDashboardPopoutRenderer
} = vi.hoisted(() => {
  // A fake OS clipboard: this fork's text writes verify by reading the same
  // buffer back (PC-5611/8977), so the mock has to actually hold what landed.
  const clipboardBuffer = { text: 'terminal clipboard text' }
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    clipboardBuffer,
    clipboardReadText: vi.fn(() => clipboardBuffer.text),
    clipboardWriteText: vi.fn((text: string) => {
      clipboardBuffer.text = text
    }),
    clipboardReadImage: vi.fn(),
    clipboardWriteImage: vi.fn(),
    clipboardWriteBuffer: vi.fn(),
    isDashboardPopoutRenderer: vi.fn(() => true)
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  clipboard: {
    readText: clipboardReadText,
    readBuffer: vi.fn(),
    writeText: clipboardWriteText,
    readImage: clipboardReadImage,
    writeImage: clipboardWriteImage,
    writeBuffer: clipboardWriteBuffer
  },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  nativeImage: { createFromBuffer: vi.fn() }
}))

vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer }))
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(async () => undefined),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn(),
  writeRemoteFileToClipboard: vi.fn()
}))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

const popoutEvent = {
  sender: {
    id: 42,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///popout.html'
  }
}

describe('dashboard popout clipboard access', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    isDashboardPopoutRenderer.mockReturnValue(true)
    clipboardBuffer.text = 'terminal clipboard text'
    setTrustedClipboardRendererWebContentsId(17)
    registerClipboardHandlers({} as never)
  })

  it('allows terminal text copy and paste through the exact popout renderer', async () => {
    await expect(handlers.get('clipboard:readText')?.(popoutEvent)).resolves.toBe(
      'terminal clipboard text'
    )
    // true, not void: this fork's writeText reports whether the write was
    // verified by read-back, so the renderer can surface a silent failure.
    await expect(
      handlers.get('clipboard:writeText')?.(popoutEvent, 'terminal selection')
    ).resolves.toBe(true)

    expect(clipboardWriteText).toHaveBeenCalledWith('terminal selection')
    expect(clipboardBuffer.text).toBe('terminal selection')
  })

  it('does not extend popout authority to selection, image, file, or remote clipboard APIs', async () => {
    await expect(handlers.get('clipboard:readSelectionText')?.(popoutEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    await expect(
      handlers.get('clipboard:writeSelectionText')?.(popoutEvent, 'primary selection')
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(handlers.get('clipboard:saveImageAsTempFile')?.(popoutEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(() =>
      handlers.get('clipboard:writeFile')?.(popoutEvent, {
        filePath: '/tmp/copied-file.txt',
        connectionId: 'ssh-secret'
      })
    ).toThrow('Unauthorized clipboard IPC sender')
    expect(() =>
      handlers.get('clipboard:writeImage')?.(popoutEvent, 'data:image/png;base64,AAAA')
    ).toThrow('Unauthorized clipboard IPC sender')

    expect(clipboardReadImage).not.toHaveBeenCalled()
    expect(clipboardWriteImage).not.toHaveBeenCalled()
    expect(clipboardWriteBuffer).not.toHaveBeenCalled()
  })

  it('still rejects unrelated renderer windows from text clipboard APIs', async () => {
    isDashboardPopoutRenderer.mockReturnValue(false)

    await expect(handlers.get('clipboard:readText')?.(popoutEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    await expect(handlers.get('clipboard:writeText')?.(popoutEvent, 'secret')).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )

    expect(clipboardReadText).not.toHaveBeenCalled()
    expect(clipboardWriteText).not.toHaveBeenCalled()
  })
})
