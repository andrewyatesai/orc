// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCachedWindowsTerminalCapabilities,
  getWindowsTerminalCapabilityOwnerKey,
  loadWindowsTerminalCapabilities,
  refreshWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from './windows-terminal-capabilities'

// Covers the non-local read paths: runtime-environment RPC and the SSH preflight bridge.
describe('windows terminal capabilities on remote hosts', () => {
  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    vi.unstubAllGlobals()
  })

  it('loads remote runtime host capabilities through runtime RPC', async () => {
    const runtimeEnvironmentCall = vi.fn(async (args: { selector: string; method: string }) => {
      const resultByMethod: Record<string, unknown> = {
        'status.get': {
          hostPlatform: 'win32',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2
        },
        'host.wsl.isAvailable': true,
        'host.wsl.listDistros': ['Ubuntu'],
        'host.pwsh.isAvailable': true,
        'host.gitBash.isAvailable': false,
        'host.nushell.isAvailable': false
      }
      return {
        id: args.method,
        ok: true,
        result: resultByMethod[args.method]
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeEnvironmentCall
        }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({
        ownerKey: 'runtime:env-win',
        target: { kind: 'environment', environmentId: 'env-win' }
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.wsl.isAvailable' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.wsl.listDistros' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.pwsh.isAvailable' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.gitBash.isAvailable' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.nushell.isAvailable' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'status.get' })
    )
  })

  it('loads SSH Windows host capabilities through the SSH preflight bridge', async () => {
    const detectRemoteWindowsTerminalCapabilities = vi.fn().mockResolvedValue({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({
        ownerKey: 'ssh:ssh-1',
        sshConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(detectRemoteWindowsTerminalCapabilities).toHaveBeenCalledWith({
      connectionId: 'ssh-1'
    })
    expect(getCachedWindowsTerminalCapabilities('ssh:ssh-1')).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
  })

  it('derives the SSH owner cache key when callers omit ownerKey', async () => {
    const detectRemoteWindowsTerminalCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        wslAvailable: true,
        wslDistros: ['Ubuntu'],
        pwshAvailable: true,
        gitBashAvailable: true,
        hostPlatform: 'win32'
      })
      .mockResolvedValueOnce({
        wslAvailable: true,
        wslDistros: ['Ubuntu', 'Debian'],
        pwshAvailable: true,
        gitBashAvailable: false,
        hostPlatform: 'win32'
      })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })

    const sshOwnerKey = getWindowsTerminalCapabilityOwnerKey(null, 'ssh-1')
    await expect(loadWindowsTerminalCapabilities({ sshConnectionId: 'ssh-1' })).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(getCachedWindowsTerminalCapabilities(sshOwnerKey)).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      nushellAvailable: false,
      hostPlatform: null,
      isLoading: false
    })

    await expect(
      refreshWindowsTerminalCapabilities(undefined, { kind: 'local' }, 'ssh-1')
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu', 'Debian'],
      pwshAvailable: true,
      gitBashAvailable: false,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(getCachedWindowsTerminalCapabilities(sshOwnerKey)).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu', 'Debian'],
      pwshAvailable: true,
      gitBashAvailable: false,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
  })

  it('loads runtime-owned SSH capabilities through runtime RPC with a scoped cache key', async () => {
    const detectRemoteWindowsTerminalCapabilities = vi.fn()
    const runtimeEnvironmentCall = vi.fn(async (args: { selector: string; method: string }) => {
      const resultByMethod: Record<string, unknown> = {
        'status.get': {
          hostPlatform: 'linux',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2
        },
        'preflight.detectRemoteWindowsTerminalCapabilities': {
          wslAvailable: true,
          wslDistros: ['Ubuntu'],
          pwshAvailable: true,
          gitBashAvailable: false,
          hostPlatform: 'win32'
        }
      }
      return {
        id: args.method,
        ok: true,
        result: resultByMethod[args.method]
      }
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        },
        runtimeEnvironments: {
          call: runtimeEnvironmentCall
        }
      }
    })

    const ownerKey = getWindowsTerminalCapabilityOwnerKey('env-1', 'ssh-1')
    expect(ownerKey).toBe('runtime:env-1:ssh:ssh-1')

    await expect(
      loadWindowsTerminalCapabilities({
        target: { kind: 'environment', environmentId: 'env-1' },
        sshConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(detectRemoteWindowsTerminalCapabilities).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'preflight.detectRemoteWindowsTerminalCapabilities',
        params: { connectionId: 'ssh-1' }
      })
    )
    expect(getCachedWindowsTerminalCapabilities(ownerKey)).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      nushellAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
    expect(getCachedWindowsTerminalCapabilities('ssh:ssh-1')).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      nushellAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
  })

  it('coerces missing nushellAvailable from older SSH hosts to false', async () => {
    // Why: an older deployed relay omits the field; gating must stay a real boolean.
    const detectRemoteWindowsTerminalCapabilities = vi.fn().mockResolvedValue({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({ ownerKey: 'ssh:old-relay', sshConnectionId: 'old-relay' })
    ).resolves.toMatchObject({ nushellAvailable: false, gitBashAvailable: true })
  })
})
