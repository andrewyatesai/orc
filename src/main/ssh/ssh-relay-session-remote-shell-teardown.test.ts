import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import {
  DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS,
  HOST_SLEEP_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
} from '../../shared/ssh-types'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock } = vi.hoisted(() => ({ muxRequestMock: vi.fn() }))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))
vi.mock('./ssh-relay-reset', () => ({
  forceStopRelayForTarget: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true)
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const { forceStopRelayForTarget } = await import('./ssh-relay-reset')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')
const { getPtyIdsForConnection } = await import('../ipc/pty')

describe('SSH relay remote shell teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  it('widens relay grace to a bounded window before host sleep', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn, 600)
    vi.mocked(session.getMux()!.notify).mockClear()

    session.prepareForHostSleep()

    expect(session.getMux()?.notify).toHaveBeenCalledWith(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: HOST_SLEEP_SSH_RELAY_GRACE_PERIOD_SECONDS
    })
  })

  it('keeps an explicit keep-alive-until-reset grace before host sleep', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn, 0)
    vi.mocked(session.getMux()!.notify).mockClear()

    session.prepareForHostSleep()

    expect(session.getMux()?.notify).toHaveBeenCalledWith(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: 0
    })
  })

  it('defaults an unconfigured target to the bounded grace period', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(session.getMux()?.notify).toHaveBeenCalledWith(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS
    })
  })

  describe('reaping panes closed while the relay was unreachable', () => {
    const closedLease = (overrides: Record<string, unknown> = {}) => ({
      targetId: 'target-1',
      ptyId: 'pty-1',
      state: 'terminated' as const,
      createdAt: 1,
      updatedAt: 2,
      killRequestedAt: 3,
      incarnationId: 'inc-1',
      ...overrides
    })
    const relayReporting = async (
      sessions: { id: string; incarnationId?: string }[] | Error,
      shutdown = vi.fn().mockResolvedValue(undefined)
    ) => {
      const { getSshPtyProvider } = await import('../ipc/pty')
      const listProcesses =
        sessions instanceof Error
          ? vi.fn().mockRejectedValue(sessions)
          : vi.fn().mockResolvedValue(sessions)
      vi.mocked(getSshPtyProvider).mockReturnValue({
        attachForReconnect: vi.fn().mockResolvedValue({}),
        listProcesses,
        shutdown,
        dispose: vi.fn()
      } as unknown as ReturnType<typeof getSshPtyProvider>)
      return { listProcesses, shutdown }
    }

    it('kills the remote shell whose incarnation still matches the lease', async () => {
      const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
      vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([closedLease()])
      const { shutdown } = await relayReporting([
        { id: 'ssh:target-1@@pty-1', incarnationId: 'inc-1' }
      ])
      const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

      await session.establish(mockConn)

      expect(shutdown).toHaveBeenCalledWith('ssh:target-1@@pty-1', {
        immediate: true,
        keepHistory: false
      })
      expect(mockStore.clearSshRemotePtyKillIntent).toHaveBeenCalledWith('target-1', 'pty-1')
    })

    it('never kills a relay id that now belongs to a different PTY', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
        vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([closedLease()])
        const { shutdown } = await relayReporting([
          { id: 'ssh:target-1@@pty-1', incarnationId: 'someone-elses-pane' }
        ])
        const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

        await session.establish(mockConn)

        expect(shutdown).not.toHaveBeenCalled()
        expect(mockStore.clearSshRemotePtyKillIntent).toHaveBeenCalledWith('target-1', 'pty-1')
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('never kills a lease that recorded no incarnation', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
        vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
          closedLease({ incarnationId: undefined })
        ])
        const { shutdown } = await relayReporting([
          { id: 'ssh:target-1@@pty-1', incarnationId: 'inc-1' }
        ])
        const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

        await session.establish(mockConn)

        expect(shutdown).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('clears the intent when the remote shell is already gone', async () => {
      const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
      vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([closedLease()])
      const { shutdown } = await relayReporting([])
      const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

      await session.establish(mockConn)

      expect(shutdown).not.toHaveBeenCalled()
      expect(mockStore.clearSshRemotePtyKillIntent).toHaveBeenCalledWith('target-1', 'pty-1')
    })

    it('keeps the intent when the relay listing fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
        vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([closedLease()])
        await relayReporting(new Error('relay unreachable'))
        const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

        await session.establish(mockConn)

        expect(session.getState()).toBe('ready')
        expect(mockStore.clearSshRemotePtyKillIntent).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('keeps the intent when the reaping shutdown fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
        vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([closedLease()])
        await relayReporting(
          [{ id: 'ssh:target-1@@pty-1', incarnationId: 'inc-1' }],
          vi.fn().mockRejectedValue(new Error('Multiplexer disposed'))
        )
        const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

        await session.establish(mockConn)

        expect(session.getState()).toBe('ready')
        expect(mockStore.clearSshRemotePtyKillIntent).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('does not list remote PTYs when no pane is waiting to be reaped', async () => {
      const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
      const { listProcesses } = await relayReporting([])
      const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

      await session.establish(mockConn)

      expect(listProcesses).not.toHaveBeenCalled()
    })
  })

  describe('shutdownRemoteRelay', () => {
    it('kills every remote PTY and then the relay daemon', async () => {
      const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
      vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
        {
          targetId: 'target-1',
          ptyId: 'pty-7',
          state: 'detached',
          createdAt: 1,
          updatedAt: 2
        }
      ])
      const shutdown = vi.fn().mockResolvedValue(undefined)
      const { getSshPtyProvider } = await import('../ipc/pty')
      vi.mocked(getSshPtyProvider).mockReturnValue({
        attachForReconnect: vi.fn().mockResolvedValue({}),
        listProcesses: vi.fn().mockResolvedValue([]),
        shutdown,
        dispose: vi.fn()
      } as unknown as ReturnType<typeof getSshPtyProvider>)
      const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
      await session.establish(mockConn)

      await session.shutdownRemoteRelay()

      expect(shutdown).toHaveBeenCalledWith('ssh:target-1@@pty-7', {
        immediate: true,
        keepHistory: false
      })
      expect(forceStopRelayForTarget).toHaveBeenCalledWith(mockConn, 'target-1')
    })

    it('survives a relay that cannot be stopped', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
        vi.mocked(forceStopRelayForTarget).mockRejectedValueOnce(new Error('host unreachable'))
        const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
        await session.establish(mockConn)

        await expect(session.shutdownRemoteRelay()).resolves.toBeUndefined()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('skips the POSIX relay stop script on Windows remotes', async () => {
      const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
      vi.mocked(deployAndLaunchRelay).mockResolvedValue({
        transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
        platform: 'win32-x64',
        hostPlatform: getRemoteHostPlatform('win32-x64')
      } as unknown as Awaited<ReturnType<typeof deployAndLaunchRelay>>)
      const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
      await session.establish(mockConn)

      await session.shutdownRemoteRelay()

      expect(forceStopRelayForTarget).not.toHaveBeenCalled()
    })
  })
})
