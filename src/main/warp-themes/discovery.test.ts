import { beforeEach, describe, expect, it, vi } from 'vitest'

const platformMock = vi.hoisted(() => vi.fn())
const homedirMock = vi.hoisted(() => vi.fn(() => '/userhome/alice'))
type MockDirectoryEntry = {
  name: string
  isDirectory: () => boolean
}

const readdirSyncMock = vi.hoisted(() => vi.fn<() => MockDirectoryEntry[]>(() => []))

vi.mock('fs', () => ({
  readdirSync: readdirSyncMock
}))

vi.mock('os', () => ({
  homedir: homedirMock,
  platform: platformMock
}))

import { getWarpThemeDirectories, warpThemeSourceLabelForDirectory } from './discovery'

function directoryEntry(name: string): MockDirectoryEntry {
  return {
    name,
    isDirectory: () => true
  }
}

function fileEntry(name: string): MockDirectoryEntry {
  return {
    name,
    isDirectory: () => false
  }
}

describe('getWarpThemeDirectories', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    platformMock.mockReset()
    homedirMock.mockReturnValue('/userhome/alice')
    readdirSyncMock.mockReset()
    readdirSyncMock.mockReturnValue([])
  })

  it('returns macOS Warp channel theme directories in stable-first order', () => {
    platformMock.mockReturnValue('darwin')
    expect(getWarpThemeDirectories()).toEqual([
      '/userhome/alice/.warp/themes',
      '/userhome/alice/.warp-preview/themes',
      '/userhome/alice/.warp-oss/themes',
      '/userhome/alice/.warp-dev/themes',
      '/userhome/alice/.warp-local/themes',
      '/userhome/alice/.warp-integration/themes'
    ])
  })

  it('adds dynamic macOS .warp directories after known channels', () => {
    platformMock.mockReturnValue('darwin')
    readdirSyncMock.mockReturnValue([
      directoryEntry('.warp-future'),
      fileEntry('.warp-note'),
      directoryEntry('.not-warp'),
      directoryEntry('.warp-preview')
    ])

    expect(getWarpThemeDirectories()).toEqual([
      '/userhome/alice/.warp/themes',
      '/userhome/alice/.warp-preview/themes',
      '/userhome/alice/.warp-oss/themes',
      '/userhome/alice/.warp-dev/themes',
      '/userhome/alice/.warp-local/themes',
      '/userhome/alice/.warp-integration/themes',
      '/userhome/alice/.warp-future/themes'
    ])
  })

  it('returns Linux XDG data channel directories in stable-first order', () => {
    platformMock.mockReturnValue('linux')
    vi.stubEnv('XDG_DATA_HOME', '/data/alice')
    expect(getWarpThemeDirectories()).toEqual([
      '/data/alice/warp-terminal/themes',
      '/data/alice/warp-terminal-preview/themes',
      '/data/alice/warp-oss/themes',
      '/data/alice/warp-terminal-dev/themes',
      '/data/alice/warp-terminal-local/themes',
      '/data/alice/warp-terminal-integration/themes'
    ])
  })

  it('adds dynamic Linux warp data directories', () => {
    platformMock.mockReturnValue('linux')
    vi.stubEnv('XDG_DATA_HOME', '/data/alice')
    readdirSyncMock.mockReturnValue([
      directoryEntry('warp-future'),
      directoryEntry('warp-terminal'),
      directoryEntry('not-warp'),
      fileEntry('warp-note')
    ])

    expect(getWarpThemeDirectories()).toEqual([
      '/data/alice/warp-terminal/themes',
      '/data/alice/warp-terminal-preview/themes',
      '/data/alice/warp-oss/themes',
      '/data/alice/warp-terminal-dev/themes',
      '/data/alice/warp-terminal-local/themes',
      '/data/alice/warp-terminal-integration/themes',
      '/data/alice/warp-future/themes'
    ])
  })

  it('ignores relative Linux XDG data home values', () => {
    platformMock.mockReturnValue('linux')
    vi.stubEnv('XDG_DATA_HOME', 'relative-data-home')

    expect(getWarpThemeDirectories()).toEqual([
      '/userhome/alice/.local/share/warp-terminal/themes',
      '/userhome/alice/.local/share/warp-terminal-preview/themes',
      '/userhome/alice/.local/share/warp-oss/themes',
      '/userhome/alice/.local/share/warp-terminal-dev/themes',
      '/userhome/alice/.local/share/warp-terminal-local/themes',
      '/userhome/alice/.local/share/warp-terminal-integration/themes'
    ])
    expect(readdirSyncMock).toHaveBeenCalledWith('/userhome/alice/.local/share', {
      withFileTypes: true
    })
  })

  it('returns Windows app data channel directories with Windows separators', () => {
    platformMock.mockReturnValue('win32')
    homedirMock.mockReturnValue('C:\\userhome\\alice')
    vi.stubEnv('APPDATA', 'C:\\userhome\\alice\\AppData\\Roaming')
    expect(getWarpThemeDirectories()).toEqual([
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\Warp\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpPreview\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpOss\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpDev\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpLocal\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpIntegration\\data\\themes'
    ])
  })

  it('adds dynamic Windows Warp app data directories', () => {
    platformMock.mockReturnValue('win32')
    vi.stubEnv('APPDATA', 'C:\\userhome\\alice\\AppData\\Roaming')
    readdirSyncMock.mockReturnValue([
      directoryEntry('WarpFuture'),
      directoryEntry('WarpPreview'),
      fileEntry('WarpNote')
    ])

    expect(getWarpThemeDirectories()).toEqual([
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\Warp\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpPreview\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpOss\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpDev\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpLocal\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpIntegration\\data\\themes',
      'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpFuture\\data\\themes'
    ])
  })
})

describe('warpThemeSourceLabelForDirectory', () => {
  it('labels macOS and Linux theme directories by their Warp data home', () => {
    expect(warpThemeSourceLabelForDirectory('/userhome/alice/.warp-preview/themes')).toBe(
      '.warp-preview'
    )
    expect(warpThemeSourceLabelForDirectory('/data/alice/warp-terminal-preview/themes')).toBe(
      'warp-terminal-preview'
    )
  })

  it('labels Windows theme directories by app folder instead of data', () => {
    expect(
      warpThemeSourceLabelForDirectory(
        'C:\\userhome\\alice\\AppData\\Roaming\\warp\\WarpPreview\\data\\themes'
      )
    ).toBe('WarpPreview')
  })

  it('falls back to the nearest non-empty parent for unfamiliar shapes', () => {
    expect(warpThemeSourceLabelForDirectory('/userhome/alice/custom/themes')).toBe('custom')
    expect(warpThemeSourceLabelForDirectory('/userhome/alice/custom')).toBe('custom')
  })
})
