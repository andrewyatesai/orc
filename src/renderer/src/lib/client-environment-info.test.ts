import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveClientEnvironmentFooter,
  resolveClientEnvironmentInfo
} from './client-environment-info'

// Why: prove the renderer resolver reads the real preload surface (platform.get +
// updater.getVersion) rather than a hand-built double — arch/shell must flow through.
function stubPreloadApi(overrides: {
  platform?: Partial<{
    platform: string
    osRelease: string
    arch: string
    shell: string
  }>
  getVersion?: () => Promise<string>
}): void {
  vi.stubGlobal('window', {
    api: {
      platform: {
        get: () => ({
          platform: 'darwin',
          osRelease: '14.5',
          arch: 'arm64',
          shell: '/bin/zsh',
          displayServer: null,
          ...overrides.platform
        })
      },
      updater: {
        getVersion: overrides.getVersion ?? (() => Promise.resolve('1.2.3'))
      }
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveClientEnvironmentInfo', () => {
  it('pulls version and platform (incl. arch + shell) from the preload api', async () => {
    stubPreloadApi({})
    await expect(resolveClientEnvironmentInfo()).resolves.toEqual({
      appVersion: '1.2.3',
      platform: 'darwin',
      osRelease: '14.5',
      arch: 'arm64',
      shell: '/bin/zsh'
    })
  })

  it('omits shell when the preload reports none', async () => {
    stubPreloadApi({ platform: { shell: '' } })
    const info = await resolveClientEnvironmentInfo()
    expect(info.shell).toBeUndefined()
  })

  it('falls back to unknown when the version lookup fails', async () => {
    stubPreloadApi({ getVersion: () => Promise.reject(new Error('no updater')) })
    const info = await resolveClientEnvironmentInfo()
    expect(info.appVersion).toBe('unknown')
  })
})

describe('resolveClientEnvironmentFooter', () => {
  it('renders a marked, copy-pasteable footer through the preload surface', async () => {
    stubPreloadApi({})
    const footer = await resolveClientEnvironmentFooter()
    expect(footer.startsWith('---\nOrca: 1.2.3')).toBe(true)
    expect(footer).toContain('OS: darwin 14.5 (arm64)')
    expect(footer).toContain('Shell: /bin/zsh')
  })
})
