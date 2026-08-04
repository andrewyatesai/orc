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

  it('keeps legacy writes non-rejecting while verified terminal writes report stale text', async () => {
    // Simulate the silent OS write failure both paths exist to catch: nothing
    // lands, so every read-back returns the stale buffer.
    clipboardWriteText.mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The fork's writeText reports the unverified write as false rather than
    // rejecting; only writeTerminalText keeps upstream's throwing contract.
    await expect(handlers.get('clipboard:writeText')?.(popoutEvent, 'legacy copy')).resolves.toBe(
      false
    )
    await expect(
      handlers.get('clipboard:writeTerminalText')?.(popoutEvent, 'verified terminal copy')
    ).rejects.toThrow('Clipboard write verification failed')

    clipboardWriteText.mockImplementation((text: string) => {
      clipboardBuffer.text = text
    })
    await expect(
      handlers.get('clipboard:writeTerminalText')?.(popoutEvent, 'confirmed terminal copy')
    ).resolves.toBeUndefined()
    warn.mockRestore()

    expect(clipboardWriteText).toHaveBeenCalledWith('legacy copy')
    expect(clipboardWriteText).toHaveBeenCalledWith('verified terminal copy')
    expect(clipboardWriteText).toHaveBeenCalledWith('confirmed terminal copy')
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
    await expect(
      handlers.get('clipboard:writeTerminalText')?.(popoutEvent, 'secret')
    ).rejects.toThrow('Unauthorized clipboard IPC sender')

    expect(clipboardReadText).not.toHaveBeenCalled()
    expect(clipboardWriteText).not.toHaveBeenCalled()
  })

  it('applies the text size gate to verified terminal writes', async () => {
    await expect(
      handlers.get('clipboard:writeTerminalText')?.(
        popoutEvent,
        'copied-secret-token-value'.repeat(900_000)
      )
    ).rejects.toThrow('Clipboard text is too large to copy safely.')
    expect(clipboardWriteText).not.toHaveBeenCalled()
  })
})
