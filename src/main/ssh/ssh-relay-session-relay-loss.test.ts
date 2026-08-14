import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock } = vi.hoisted(() => ({ muxRequestMock: vi.fn() }))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
// Why: unlike the stock stub, this mux stores onDispose handlers and fires them on dispose(reason),
// so releasing the watcher before a teardown write is observable — the seam this suite guards.
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    private disposeHandlers = new Set<(reason: string) => void>()
    private disposed = false
    notify = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn((cb: (reason: string) => void) => {
      this.disposeHandlers.add(cb)
      return () => this.disposeHandlers.delete(cb)
    })
    dispose = vi.fn((reason: string = 'shutdown') => {
      if (this.disposed) {
        return
      }
      this.disposed = true
      for (const cb of this.disposeHandlers) {
        cb(reason)
      }
    })
    isDisposed = vi.fn(() => this.disposed)
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

const { getPtyIdsForConnection } = await import('../ipc/pty')

async function createReadySession() {
  const deps = createMockDeps()
  const onRelayLost = vi.fn()
  const session = new SshRelaySession(
    'target-1',
    deps.getMainWindow,
    deps.mockStore,
    deps.mockPortForward
  )
  session.setOnRelayLost(onRelayLost)
  await session.establish({} as SshConnection)
  expect(session.getState()).toBe('ready')
  return { session, onRelayLost, deps }
}

describe('SshRelaySession relay-loss watcher release ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  // #13737: a saturated control lane turns a teardown-time mux write into
  // mux.dispose('connection_lost'). If the watcher is still armed when that fires during our own
  // dispose(), the session re-enters recovery and schedules a redundant relay redeploy. The fix
  // releases the watcher ahead of every teardown mux write; removeAllForwards stands in for that
  // write since it runs after the release point but before teardownProviders.
  it('does not report relay loss when a teardown mux write kills the mux on dispose', async () => {
    const { session, onRelayLost, deps } = await createReadySession()
    const mux = session.getMux()!
    vi.mocked(deps.mockPortForward.removeAllForwards).mockImplementation(async () => {
      mux.dispose('connection_lost')
    })

    session.dispose()

    expect(mux.dispose).toHaveBeenCalledWith('connection_lost')
    expect(onRelayLost).not.toHaveBeenCalled()
    expect(session.getState()).toBe('disposed')
  })

  it('does not report relay loss when a teardown mux write kills the old mux on reconnect', async () => {
    const { session, onRelayLost, deps } = await createReadySession()
    const oldMux = session.getMux()!
    vi.mocked(deps.mockPortForward.removeAllForwards).mockImplementation(async () => {
      oldMux.dispose('connection_lost')
    })

    await session.reconnect({} as SshConnection)

    expect(oldMux.dispose).toHaveBeenCalledWith('connection_lost')
    expect(onRelayLost).not.toHaveBeenCalled()
  })

  // A genuine post-'ready' relay drop (not our own teardown) must still route into recovery, so the
  // release above cannot be a blanket suppression.
  it('still reports relay loss when the live mux drops outside teardown', async () => {
    const { session, onRelayLost } = await createReadySession()

    session.getMux()!.dispose('connection_lost')

    expect(onRelayLost).toHaveBeenCalledWith('target-1')
  })
})
