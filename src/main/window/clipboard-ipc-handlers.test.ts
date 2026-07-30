import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const {
  removeHandlerMock,
  handleMock,
  spawnMock,
  childStdinEndMock,
  resolveAuthorizedPathMock,
  fsMkdirMock,
  fsMkdtempMock,
  fsReaddirMock,
  fsRmMock,
  fsWriteFileMock,
  fsOpenMock,
  fsStatMock,
  clipboardReadTextMock,
  clipboardReadBufferMock,
  clipboardWriteTextMock,
  clipboardReadImageMock,
  clipboardWriteImageMock,
  clipboardWriteBufferMock,
  nativeImageCreateFromBufferMock,
  nativeImageCreateFromPathMock,
  randomUUIDMock,
  getSshFilesystemProviderMock,
  callRuntimeEnvironmentMock
} = vi.hoisted(() => ({
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  childStdinEndMock: vi.fn(),
  spawnMock: vi.fn(() => {
    const child = {
      stdin: { end: childStdinEndMock },
      on: vi.fn((event: string, callback: (code?: number) => void) => {
        if (event === 'exit') {
          queueMicrotask(() => callback(0))
        }
        return child
      })
    }
    return child
  }),
  resolveAuthorizedPathMock: vi.fn(),
  fsMkdirMock: vi.fn(),
  fsMkdtempMock: vi.fn(),
  fsReaddirMock: vi.fn(),
  fsRmMock: vi.fn(),
  fsWriteFileMock: vi.fn(),
  fsOpenMock: vi.fn(),
  fsStatMock: vi.fn(),
  clipboardReadTextMock: vi.fn(),
  clipboardReadBufferMock: vi.fn(),
  clipboardWriteTextMock: vi.fn(),
  clipboardReadImageMock: vi.fn(),
  clipboardWriteImageMock: vi.fn(),
  clipboardWriteBufferMock: vi.fn(),
  nativeImageCreateFromBufferMock: vi.fn(),
  nativeImageCreateFromPathMock: vi.fn(),
  randomUUIDMock: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
  getSshFilesystemProviderMock: vi.fn(),
  callRuntimeEnvironmentMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('node:fs/promises', () => ({
  mkdir: fsMkdirMock,
  readdir: fsReaddirMock,
  rm: fsRmMock,
  open: fsOpenMock,
  stat: fsStatMock,
  default: {
    mkdtemp: fsMkdtempMock,
    readdir: fsReaddirMock,
    rm: fsRmMock,
    stat: fsStatMock,
    writeFile: fsWriteFileMock
  }
}))

vi.mock('../ipc/filesystem-auth', () => ({
  PATH_ACCESS_DENIED_MESSAGE:
    'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.',
  isENOENT: (error: unknown): boolean =>
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT',
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  },
  clipboard: {
    readText: clipboardReadTextMock,
    readBuffer: clipboardReadBufferMock,
    writeText: clipboardWriteTextMock,
    readImage: clipboardReadImageMock,
    writeImage: clipboardWriteImageMock,
    writeBuffer: clipboardWriteBufferMock
  },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  nativeImage: {
    createFromBuffer: nativeImageCreateFromBufferMock,
    createFromPath: nativeImageCreateFromPathMock
  }
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  requireSshFilesystemProvider: (connectionId: string) => {
    const provider = getSshFilesystemProviderMock(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider
  }
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'
import { cleanupExpiredRemoteClipboardFiles } from './clipboard-remote-file-copy'

function getRegisteredHandlers(): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  for (const [channel, handler] of handleMock.mock.calls as [
    string,
    (...args: unknown[]) => unknown
  ][]) {
    handlers.set(channel, handler)
  }
  return handlers
}

function makeClipboardEvent(senderOverrides: Record<string, unknown> = {}): {
  sender: Record<string, unknown>
} {
  return {
    sender: {
      id: 17,
      getType: () => 'window',
      getURL: () => 'file:///orca/index.html',
      isDestroyed: () => false,
      ...senderOverrides
    }
  }
}

function trackPromiseSettled(promise: Promise<unknown>): () => boolean {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  return () => settled
}

function dirent(name: string, directory = true): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => directory }
}

describe('registerClipboardHandlers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1760000000000)
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    spawnMock.mockClear()
    childStdinEndMock.mockClear()
    resolveAuthorizedPathMock.mockReset()
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => path)
    fsMkdirMock.mockReset()
    fsMkdirMock.mockResolvedValue(undefined)
    fsMkdtempMock.mockReset()
    fsMkdtempMock.mockImplementation(async (prefix: string) => `${prefix}a1b2c3`)
    fsReaddirMock.mockReset()
    fsReaddirMock.mockResolvedValue([])
    fsRmMock.mockReset()
    fsRmMock.mockResolvedValue(undefined)
    fsWriteFileMock.mockReset()
    fsOpenMock.mockReset()
    fsStatMock.mockReset()
    fsStatMock.mockResolvedValue({})
    clipboardReadTextMock.mockReset()
    clipboardReadBufferMock.mockReset()
    clipboardReadBufferMock.mockReturnValue(Buffer.alloc(0))
    clipboardWriteTextMock.mockReset()
    clipboardReadImageMock.mockReset()
    clipboardWriteImageMock.mockReset()
    clipboardWriteBufferMock.mockReset()
    nativeImageCreateFromBufferMock.mockReset()
    nativeImageCreateFromPathMock.mockReset()
    randomUUIDMock.mockReset()
    randomUUIDMock.mockReturnValue('00000000-0000-4000-8000-000000000000')
    getSshFilesystemProviderMock.mockReset()
    callRuntimeEnvironmentMock.mockReset()
    setTrustedClipboardRendererWebContentsId(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('registers normal and selection text clipboard IPC handlers', async () => {
    // A per-buffer fake clipboard so the verified writes read back what landed
    // in the SAME buffer they targeted.
    const buffers = { standard: 'standard text', selection: 'selection text' }
    const bufferFor = (type?: string): 'standard' | 'selection' =>
      type === 'selection' ? 'selection' : 'standard'
    clipboardReadTextMock.mockImplementation((type?: string) => buffers[bufferFor(type)])
    clipboardWriteTextMock.mockImplementation((text: string, type?: string) => {
      buffers[bufferFor(type)] = text
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(handlers.get('clipboard:readText')?.(makeClipboardEvent())).resolves.toBe(
      'standard text'
    )
    await expect(handlers.get('clipboard:readSelectionText')?.(makeClipboardEvent())).resolves.toBe(
      'selection text'
    )
    await expect(
      handlers.get('clipboard:writeText')?.(makeClipboardEvent(), 'normal text')
    ).resolves.toBe(true)
    await expect(
      handlers.get('clipboard:writeSelectionText')?.(makeClipboardEvent(), 'primary text')
    ).resolves.toBe(true)

    expect(clipboardReadTextMock).toHaveBeenCalledWith()
    expect(clipboardReadTextMock).toHaveBeenCalledWith('selection')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('normal text')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('primary text', 'selection')
  })

  it('rejects clipboard IPC from senders outside the current main renderer', async () => {
    setTrustedClipboardRendererWebContentsId(17)
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const untrustedEvent = makeClipboardEvent({ id: 42 })
    await expect(handlers.get('clipboard:readText')?.(untrustedEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    await expect(
      handlers.get('clipboard:writeText')?.(untrustedEvent, 'copied-secret-token-value')
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(untrustedEvent, {
        connectionId: 'ssh-secret'
      })
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    expect(() =>
      handlers.get('clipboard:writeFile')?.(untrustedEvent, '/tmp/copied-file.txt')
    ).toThrow('Unauthorized clipboard IPC sender')
    expect(() =>
      handlers.get('clipboard:writeImage')?.(untrustedEvent, 'data:image/png;base64,AAAA')
    ).toThrow('Unauthorized clipboard IPC sender')

    expect(clipboardReadTextMock).not.toHaveBeenCalled()
    expect(clipboardWriteTextMock).not.toHaveBeenCalled()
    expect(clipboardReadImageMock).not.toHaveBeenCalled()
    expect(nativeImageCreateFromBufferMock).not.toHaveBeenCalled()
    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
    expect(clipboardWriteBufferMock).not.toHaveBeenCalled()
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
  })

  it('accepts the packaged orca://app renderer origin and rejects other orca:// hosts', async () => {
    clipboardReadTextMock.mockReturnValue('clipboard text')
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:readText')?.(
        makeClipboardEvent({ getURL: () => 'orca://app/index.html' })
      )
    ).resolves.toBe('clipboard text')
    // Why: orca:// is also the deep-link scheme — only the exact app host is trusted.
    await expect(
      handlers.get('clipboard:readText')?.(
        makeClipboardEvent({ getURL: () => 'orca://focus/term_x' })
      )
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(
      handlers.get('clipboard:readText')?.(
        makeClipboardEvent({ getURL: () => 'orca://app.evil/index.html' })
      )
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
  })

  it('writes local files through the trusted clipboard IPC handler', async () => {
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), '/tmp/copied-file.txt')
    ).resolves.toEqual({ ok: true })

    expect(fsStatMock).toHaveBeenCalledWith('/tmp/copied-file.txt')
    expect(resolveAuthorizedPathMock).toHaveBeenCalledWith('/tmp/copied-file.txt', {})
    if (process.platform === 'darwin') {
      expect(clipboardWriteBufferMock).toHaveBeenCalledWith(
        'public.file-url',
        Buffer.from('file:///tmp/copied-file.txt', 'utf8')
      )
    } else {
      expect(spawnMock).toHaveBeenCalled()
    }
  })

  it('sweeps expired remote clipboard staging directories', async () => {
    const nowMs = 1760000000000
    fsReaddirMock.mockResolvedValue([
      dirent('orca-clipboard-file-expired'),
      dirent('orca-clipboard-file-fresh'),
      dirent('orca-clipboard-file-plain-file', false),
      dirent('unrelated-temp')
    ])
    fsStatMock.mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith('expired')) {
        return { mtimeMs: nowMs - 60 * 60 * 1000 - 1 }
      }
      if (targetPath.endsWith('fresh')) {
        return { mtimeMs: nowMs - 1000 }
      }
      throw new Error(`unexpected stat: ${targetPath}`)
    })

    await cleanupExpiredRemoteClipboardFiles(nowMs)

    expect(fsRmMock).toHaveBeenCalledTimes(1)
    expect(fsRmMock).toHaveBeenCalledWith(join('/tmp', 'orca-clipboard-file-expired'), {
      recursive: true,
      force: true
    })
  })

  it('materializes remote files before writing them to the OS clipboard', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 12, type: 'file', mtime: 123 }),
      downloadFile: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const tempDir = join(
      '/tmp',
      'orca-clipboard-file-1760000000000-00000000-0000-4000-8000-000000000000'
    )
    const tempPath = join(tempDir, 'report.pdf')

    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), {
        filePath: '/remote/report.pdf',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({ ok: true })

    expect(provider.stat).toHaveBeenCalledWith('/remote/report.pdf')
    expect(fsMkdirMock).toHaveBeenCalledWith(tempDir, { mode: 0o700 })
    expect(provider.downloadFile).toHaveBeenCalledWith('/remote/report.pdf', tempPath)
    expect(fsStatMock).toHaveBeenCalledWith(tempPath)
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
    expect(fsRmMock).not.toHaveBeenCalled()
  })

  it('does not materialize remote directories for OS clipboard copy', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFile: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), {
        filePath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({ ok: false, reason: 'is-directory' })

    expect(provider.downloadFile).not.toHaveBeenCalled()
    expect(fsMkdirMock).not.toHaveBeenCalled()
    expect(clipboardWriteBufferMock).not.toHaveBeenCalled()
  })

  it('cleans up remote clipboard temp files when transfer fails', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 12, type: 'file', mtime: 123 }),
      downloadFile: vi.fn().mockRejectedValue(new Error('transfer failed'))
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const tempDir = join(
      '/tmp',
      'orca-clipboard-file-1760000000000-00000000-0000-4000-8000-000000000000'
    )
    const tempPath = join(tempDir, 'report.pdf')

    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), {
        filePath: '/remote/report.pdf',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('transfer failed')

    expect(provider.downloadFile).toHaveBeenCalledWith('/remote/report.pdf', tempPath)
    expect(fsRmMock).toHaveBeenCalledWith(tempDir, { recursive: true, force: true })
    expect(clipboardWriteBufferMock).not.toHaveBeenCalled()
  })

  it('rejects unauthorized local files before touching the OS clipboard', async () => {
    resolveAuthorizedPathMock.mockRejectedValue(
      new Error(
        'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
      )
    )
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), '/etc/passwd')
    ).resolves.toEqual({ ok: false, reason: 'access-denied' })

    expect(fsStatMock).not.toHaveBeenCalled()
    expect(clipboardWriteBufferMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects clipboard IPC from destroyed, browser, and mismatched dev-origin senders', async () => {
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent({ isDestroyed: () => true }))
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent({ getType: () => 'webview' }))
    ).rejects.toThrow('Unauthorized clipboard IPC sender')

    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

    await expect(
      handlers.get('clipboard:readText')?.(
        makeClipboardEvent({ getURL: () => 'http://127.0.0.1:5173/workspace' })
      )
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent({ getURL: () => 'not a url' }))
    ).rejects.toThrow('Unauthorized clipboard IPC sender')

    expect(clipboardReadTextMock).not.toHaveBeenCalled()
  })

  it('rejects oversized text clipboard IPC reads without returning clipboard contents', async () => {
    clipboardReadTextMock.mockImplementation((clipboardType?: string) =>
      clipboardType === 'selection' ? 'selection secret' : 'standard secret'
    )

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent(), { maxBytes: 4 })
    ).rejects.toThrow('Clipboard text is too large for this paste target.')
    await expect(
      handlers.get('clipboard:readSelectionText')?.(makeClipboardEvent(), { maxBytes: 4 })
    ).rejects.toThrow('Clipboard text is too large for this paste target.')
  })

  it('yields while measuring large accepted text clipboard IPC reads', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(300_000)
    clipboardReadTextMock.mockReturnValue(text)

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const result = handlers.get('clipboard:readText')?.(makeClipboardEvent(), {
      maxBytes: text.length * 3
    })
    if (!(result instanceof Promise)) {
      throw new Error('Expected clipboard read handler to return a Promise')
    }
    const isSettled = trackPromiseSettled(result)

    await Promise.resolve()

    expect(isSettled()).toBe(false)
    await vi.runOnlyPendingTimersAsync()
    await expect(result).resolves.toBe(text)
  })

  it('yields before writing large text clipboard IPC payloads', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(300_000)
    // The verified write reads back what landed; echo it so the (bounded, for
    // this >256KiB payload) compare passes without a retry timer.
    clipboardWriteTextMock.mockImplementation((value: string) =>
      clipboardReadTextMock.mockReturnValue(value)
    )

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const result = handlers.get('clipboard:writeText')?.(makeClipboardEvent(), text)
    if (!(result instanceof Promise)) {
      throw new Error('Expected clipboard write handler to return a Promise')
    }
    const isSettled = trackPromiseSettled(result)

    await Promise.resolve()

    expect(isSettled()).toBe(false)
    expect(clipboardWriteTextMock).not.toHaveBeenCalled()
    await vi.runOnlyPendingTimersAsync()
    await expect(result).resolves.toBe(true)
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(text)
  })

  it('rejects oversized text clipboard IPC writes before calling Electron clipboard', async () => {
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:writeText')?.(
        makeClipboardEvent(),
        'copied-secret-token-value'.repeat(900_000)
      )
    ).rejects.toThrow('Clipboard text is too large to copy safely.')
    await expect(
      handlers.get('clipboard:writeSelectionText')?.(
        makeClipboardEvent(),
        'selection-secret-token-value'.repeat(900_000)
      )
    ).rejects.toThrow('Clipboard text is too large to copy safely.')
    expect(clipboardWriteTextMock).not.toHaveBeenCalled()
  })

  it('removes stale clipboard IPC handlers before registering replacements', () => {
    registerClipboardHandlers({} as never)

    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readSelectionText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeSelectionText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeImage')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeFile')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:saveImageAsTempFile')
  })
})
