import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../shared/clipboard-image'

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
import { cleanupExpiredClipboardImageTempDirs } from './clipboard-image-temp-file'

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

function dirent(name: string, directory = true): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => directory }
}

function shellIdListArray(childCount: number): Buffer {
  const value = Buffer.alloc(4 + 4 * (childCount + 1))
  value.writeUInt32LE(childCount)
  return value
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

  it('sweeps expired clipboard paste image directories', async () => {
    const nowMs = 1760000000000
    fsReaddirMock.mockResolvedValue([
      dirent('orca-paste-expired'),
      dirent('orca-paste-fresh'),
      dirent('orca-paste-plain-file.png', false),
      dirent('unrelated-temp')
    ])
    fsStatMock.mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith('expired')) {
        return { mtimeMs: nowMs - 7 * 24 * 60 * 60 * 1000 - 1 }
      }
      if (targetPath.endsWith('fresh')) {
        return { mtimeMs: nowMs - 1000 }
      }
      throw new Error(`unexpected stat: ${targetPath}`)
    })

    await cleanupExpiredClipboardImageTempDirs(nowMs)

    expect(fsRmMock).toHaveBeenCalledTimes(1)
    expect(fsRmMock).toHaveBeenCalledWith(join('/tmp', 'orca-paste-expired'), {
      recursive: true,
      force: true
    })
  })

  it('runs the clipboard paste image sweep when handlers register', async () => {
    fsReaddirMock.mockResolvedValue([dirent('orca-paste-expired')])
    fsStatMock.mockResolvedValue({ mtimeMs: 1760000000000 - 8 * 24 * 60 * 60 * 1000 })

    registerClipboardHandlers({} as never)
    await vi.waitFor(() => {
      expect(fsRmMock).toHaveBeenCalledWith(join('/tmp', 'orca-paste-expired'), {
        recursive: true,
        force: true
      })
    })
  })

  it('saves clipboard images to a private mkdtemp dir when no connection is provided', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    const pngName = 'orca-paste-00000000-0000-4000-8000-000000000000.png'
    const expectedPath = join('/tmp', 'orca-paste-a1b2c3', pngName)
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), undefined)
    ).resolves.toBe(expectedPath)
    expect(fsMkdtempMock).toHaveBeenCalledWith(join('/tmp', 'orca-paste-'))
    expect(fsWriteFileMock).toHaveBeenCalledWith(expectedPath, png)
    expect(clipboardReadBufferMock).not.toHaveBeenCalled()
    expect(fsOpenMock).not.toHaveBeenCalled()
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
  })

  it('saves an image file copied from Windows Explorer into the private mkdtemp dir', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const png = Buffer.from([4, 3, 2, 1])
    const sourcePath = 'C:\\Users\\alice\\图片\\copied-image.png'
    const pngName = 'orca-paste-00000000-0000-4000-8000-000000000000.png'
    const expectedPath = join('/tmp', 'orca-paste-a1b2c3', pngName)
    clipboardReadImageMock.mockReturnValue({ isEmpty: () => true })
    // Empty 'Shell IDList Array' = legacy single-file copy; FileNameW carries the path.
    clipboardReadBufferMock.mockImplementation((format: string) =>
      format === 'FileNameW' ? Buffer.from(`${sourcePath}\0`, 'utf16le') : Buffer.alloc(0)
    )
    const source = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(source)
    source.writeUInt32BE(13, 8)
    source.write('IHDR', 12, 'ascii')
    source.writeUInt32BE(1, 16)
    source.writeUInt32BE(1, 20)
    fsOpenMock.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: source.byteLength }),
      read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(Math.max(source.byteLength - position, 0), length)
        source.copy(buffer, offset, position, position + bytesRead)
        return { buffer, bytesRead }
      })
    })
    nativeImageCreateFromBufferMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })

    try {
      registerClipboardHandlers({} as never)

      const handlers = getRegisteredHandlers()
      await expect(
        handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), undefined)
      ).resolves.toBe(expectedPath)
      expect(clipboardReadBufferMock).toHaveBeenCalledWith('FileNameW')
      expect(fsOpenMock).toHaveBeenCalledWith(sourcePath, 'r')
      expect(nativeImageCreateFromBufferMock).toHaveBeenCalledWith(source)
      expect(fsMkdtempMock).toHaveBeenCalledWith(join('/tmp', 'orca-paste-'))
      expect(fsWriteFileMock).toHaveBeenCalledWith(expectedPath, png)
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('does not inspect FileNameW when an empty image clipboard is read outside Windows', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    clipboardReadImageMock.mockReturnValue({ isEmpty: () => true })

    try {
      registerClipboardHandlers({} as never)

      const handler = getRegisteredHandlers().get('clipboard:saveImageAsTempFile')
      await expect(handler?.(makeClipboardEvent(), undefined)).resolves.toBeNull()
      expect(clipboardReadBufferMock).not.toHaveBeenCalled()
      expect(fsOpenMock).not.toHaveBeenCalled()
      expect(nativeImageCreateFromBufferMock).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('routes a Windows Explorer FileNameW image through the target-aware attachment flow', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const sourcePath = 'C:\\Users\\alice\\图片\\copied-image.png'
    const png = Buffer.from([4, 3, 2, 1])
    clipboardReadImageMock.mockReturnValue({ isEmpty: () => true })
    clipboardReadBufferMock.mockImplementation((format: string) =>
      format === 'FileNameW' ? Buffer.from(`${sourcePath}\0`, 'utf16le') : shellIdListArray(1)
    )
    const source = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(source)
    source.writeUInt32BE(13, 8)
    source.write('IHDR', 12, 'ascii')
    source.writeUInt32BE(1, 16)
    source.writeUInt32BE(1, 20)
    const close = vi.fn().mockResolvedValue(undefined)
    fsOpenMock.mockResolvedValue({
      close,
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: source.byteLength }),
      read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(Math.max(source.byteLength - position, 0), length)
        source.copy(buffer, offset, position, position + bytesRead)
        return { buffer, bytesRead }
      })
    })
    nativeImageCreateFromBufferMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    const writeFileBase64 = vi.fn().mockResolvedValue(undefined)
    getSshFilesystemProviderMock.mockReturnValue({
      getTempDir: vi.fn().mockResolvedValue('/var/tmp'),
      writeFileBase64
    })

    try {
      registerClipboardHandlers({} as never)

      const handler = getRegisteredHandlers().get('clipboard:saveImageAsTempFile')
      await expect(handler?.(makeClipboardEvent(), { connectionId: 'ssh-1' })).resolves.toBe(
        '/var/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png'
      )
      expect(clipboardReadBufferMock).toHaveBeenCalledWith('FileNameW')
      expect(clipboardReadBufferMock).toHaveBeenCalledWith('Shell IDList Array')
      expect(fsOpenMock).toHaveBeenCalledWith(sourcePath, 'r')
      expect(nativeImageCreateFromBufferMock).toHaveBeenCalledWith(source)
      expect(close).toHaveBeenCalled()
      expect(writeFileBase64).toHaveBeenCalledWith(
        '/var/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
        png.toString('base64')
      )
      expect(fsWriteFileMock).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('saves clipboard images through the selected remote runtime host', async () => {
    const png = Buffer.alloc(512 * 1024)
    const contentBase64 = png.toString('base64')
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    callRuntimeEnvironmentMock.mockImplementation(async (_userDataPath, _runtimeId, method) => {
      if (method === 'clipboard.startImageUpload') {
        return { ok: true, result: { uploadId: 'upload-1' }, _meta: { runtimeId: 'runtime-1' } }
      }
      if (method === 'clipboard.appendImageUploadChunk') {
        return {
          ok: true,
          result: { receivedBase64Length: contentBase64.length },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      if (method === 'clipboard.commitImageUpload') {
        return {
          ok: true,
          result: '/tmp/orca-paste-remote.png',
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      throw new Error(`unexpected method: ${method}`)
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        runtimeEnvironmentId: 'remote-host-1'
      })
    ).resolves.toBe('/tmp/orca-paste-remote.png')
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      1,
      '/tmp',
      'remote-host-1',
      'clipboard.startImageUpload',
      { expectedBase64Length: contentBase64.length, connectionId: null },
      30_000
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      2,
      '/tmp',
      'remote-host-1',
      'clipboard.appendImageUploadChunk',
      {
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: contentBase64.slice(0, 512 * 1024)
      },
      30_000
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      3,
      '/tmp',
      'remote-host-1',
      'clipboard.appendImageUploadChunk',
      {
        uploadId: 'upload-1',
        offset: 512 * 1024,
        contentBase64: contentBase64.slice(512 * 1024, 1024 * 1024)
      },
      30_000
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      4,
      '/tmp',
      'remote-host-1',
      'clipboard.commitImageUpload',
      { uploadId: 'upload-1' },
      30_000
    )
    expect(fsWriteFileMock).not.toHaveBeenCalled()
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
  })

  it('aborts remote runtime clipboard image uploads when a chunk fails', async () => {
    const png = Buffer.alloc(512 * 1024)
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    callRuntimeEnvironmentMock.mockImplementation(async (_userDataPath, _runtimeId, method) => {
      if (method === 'clipboard.startImageUpload') {
        return { ok: true, result: { uploadId: 'upload-1' }, _meta: { runtimeId: 'runtime-1' } }
      }
      if (method === 'clipboard.appendImageUploadChunk') {
        return {
          ok: false,
          error: { code: 'runtime_error', message: 'append failed' },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      if (method === 'clipboard.abortImageUpload') {
        return { ok: true, result: { aborted: true }, _meta: { runtimeId: 'runtime-1' } }
      }
      throw new Error(`unexpected method: ${method}`)
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        runtimeEnvironmentId: 'remote-host-1'
      })
    ).rejects.toThrow('append failed')
    expect(callRuntimeEnvironmentMock).toHaveBeenLastCalledWith(
      '/tmp',
      'remote-host-1',
      'clipboard.abortImageUpload',
      { uploadId: 'upload-1' },
      30_000
    )
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('uploads clipboard images to the SSH host when a connection is provided', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    const writeFileBase64 = vi.fn().mockResolvedValue(undefined)
    const getTempDir = vi.fn().mockResolvedValue('/var/tmp')
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    getSshFilesystemProviderMock.mockReturnValue({ getTempDir, writeFileBase64 })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        connectionId: 'ssh-1'
      })
    ).resolves.toBe('/var/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png')
    expect(getSshFilesystemProviderMock).toHaveBeenCalledWith('ssh-1')
    expect(getTempDir).toHaveBeenCalled()
    expect(writeFileBase64).toHaveBeenCalledWith(
      '/var/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      png.toString('base64')
    )
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('uses Windows path joining for Windows SSH temp directories', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    const writeFileBase64 = vi.fn().mockResolvedValue(undefined)
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    getSshFilesystemProviderMock.mockReturnValue({
      getTempDir: vi.fn().mockResolvedValue('C:\\Users\\alice\\AppData\\Local\\Temp'),
      writeFileBase64
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        connectionId: 'ssh-1'
      })
    ).resolves.toBe(
      'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png'
    )
    expect(writeFileBase64).toHaveBeenCalledWith(
      'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      png.toString('base64')
    )
  })

  it('rejects oversized clipboard image dimensions before PNG conversion', async () => {
    const toPNG = vi.fn(() => Buffer.from([0, 1, 2, 3]))
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: CLIPBOARD_IMAGE_MAX_PIXELS + 1 }),
      isEmpty: () => false,
      toPNG
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), undefined)
    ).rejects.toThrow('Clipboard image is too large')
    expect(toPNG).not.toHaveBeenCalled()
    expect(fsWriteFileMock).not.toHaveBeenCalled()
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
  })

  it('rejects oversized clipboard PNG bytes before SSH provider lookup', async () => {
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        connectionId: 'ssh-secret'
      })
    ).rejects.toThrow('Clipboard image is too large')
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('ignores oversized clipboard write-image data before decoding base64', () => {
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const dataUrl = [
      'data:image/png;base64,',
      'A'.repeat(CLIPBOARD_IMAGE_MAX_BASE64_CHARS + 1)
    ].join('')
    handlers.get('clipboard:writeImage')?.(makeClipboardEvent(), dataUrl)

    expect(nativeImageCreateFromBufferMock).not.toHaveBeenCalled()
    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
  })

  it('ignores clipboard write images with oversized decoded dimensions', () => {
    nativeImageCreateFromBufferMock.mockReturnValue({
      getSize: () => ({ height: 1, width: CLIPBOARD_IMAGE_MAX_PIXELS + 1 }),
      isEmpty: () => false
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    handlers.get('clipboard:writeImage')?.(makeClipboardEvent(), 'data:image/png;base64,AAAA')

    expect(nativeImageCreateFromBufferMock).toHaveBeenCalled()
    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
  })
})
