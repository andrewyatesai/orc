import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hardening coverage for docs/reference/orca-daemon-authority-model.md §8:
//   item 2 — the runtime dir holding the socket + auth token must be 0700 and
//            owned privately by us, not silently adopted from whoever made it.
//   item 8 — every daemon PTY forks from the daemon's own environment, so the
//            deny list has to be applied where the daemon is spawned, not only
//            in the per-createOrAttach envToDelete a caller may omit.
// Restart sequencing and status reporting live in the sibling daemon-init tests.

const FAKE_USER_DATA = '/fake/userData'
const FAKE_RUNTIME_DIR = '/fake/userData/daemon'
const FAKE_RUST_DAEMON_BIN = '/fake/app/orca-daemon'

const {
  mkdirSyncMock,
  chmodSyncMock,
  lstatSyncMock,
  hardenSecurePathMock,
  spawnMock,
  spawnerInstances,
  getDaemonLaunchIdentityMock,
  localFallbackProvider
} = vi.hoisted(() => {
  const makeUnsubscribe = () => () => {}
  return {
    mkdirSyncMock: vi.fn(),
    chmodSyncMock: vi.fn(),
    lstatSyncMock: vi.fn((): { isDirectory: () => boolean; uid: number; mode: number } => ({
      isDirectory: () => true,
      uid: process.getuid?.() ?? 0,
      mode: 0o40700
    })),
    hardenSecurePathMock: vi.fn(),
    spawnMock: vi.fn(),
    spawnerInstances: [] as { launcher: unknown }[],
    getDaemonLaunchIdentityMock: vi.fn(async () => 'match' as string),
    localFallbackProvider: {
      onData: vi.fn(makeUnsubscribe),
      onExit: vi.fn(makeUnsubscribe),
      onReplay: vi.fn(makeUnsubscribe),
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => FAKE_USER_DATA,
    getAppPath: () => '/fake/app',
    getVersion: () => '1.2.3'
  }
}))

vi.mock('fs', () => ({
  mkdirSync: mkdirSyncMock,
  chmodSync: chmodSyncMock,
  lstatSync: lstatSyncMock,
  // Only the stubbed daemon binary and pid files exist: no socket means every
  // probe resolves false, so the launcher takes the fresh-spawn path.
  existsSync: (p: string) => p === FAKE_RUST_DAEMON_BIN || p.includes('.pid'),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT')
  }),
  writeFileSync: vi.fn()
}))

vi.mock('../../shared/secure-file', () => ({ hardenSecurePath: hardenSecurePathMock }))

vi.mock('child_process', () => ({ fork: vi.fn(), spawn: spawnMock }))

vi.mock('net', () => ({
  connect: vi.fn(() => {
    const self = {
      on(event: string, cb: () => void) {
        if (event === 'error') {
          queueMicrotask(cb)
        }
        return self
      },
      removeListener() {
        return self
      },
      destroy() {}
    }
    return self
  })
}))

vi.mock('./daemon-health', () => ({
  checkDaemonHealth: vi.fn(async () => 'healthy'),
  getDaemonLaunchIdentity: getDaemonLaunchIdentityMock,
  getMacDaemonSystemResolverHealth: vi.fn(async () => 'healthy'),
  isDaemonStaleForCurrentBundle: vi.fn(async () => false),
  killStaleDaemon: vi.fn(async () => true),
  getProcessStartedAtMs: vi.fn(() => 1_000_000),
  queryWindowsProcessIdentity: vi.fn(async () => null),
  parseDaemonPidFile: vi.fn(() => null)
}))

vi.mock('./client', () => ({
  DaemonClient: class MockDaemonClient {
    readonly ensureConnected = vi.fn(async () => {})
    readonly request = vi.fn(async () => ({ sessions: [] }))
    readonly disconnect = vi.fn()
  }
}))

vi.mock('./daemon-spawner', () => ({
  DaemonSpawner: class MockDaemonSpawner {
    readonly launcher: unknown
    readonly ensureRunning = vi.fn(async () => ({
      socketPath: '/fake/socket',
      tokenPath: '/fake/token'
    }))
    readonly resetHandle = vi.fn()
    readonly shutdown = vi.fn(async () => {})
    readonly getHandle = vi.fn(() => null)
    constructor(opts: { runtimeDir: string; launcher: unknown }) {
      this.launcher = opts.launcher
      spawnerInstances.push(this)
    }
  },
  getDaemonSocketPath: (_dir: string, version?: number) => `/fake/daemon-v${version ?? 0}.sock`,
  getDaemonTokenPath: (_dir: string, version?: number) => `/fake/daemon-v${version ?? 0}.token`,
  getDaemonPidPath: (_dir: string, version?: number) => `/fake/daemon-v${version ?? 0}.pid`,
  serializeDaemonPidFile: (obj: unknown) => JSON.stringify(obj)
}))

vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class MockDaemonPtyAdapter {
    readonly protocolVersion = 0
    readonly getActiveSessionIds = vi.fn(() => [] as string[])
    readonly fanoutSyntheticExits = vi.fn()
    readonly listProcesses = vi.fn(async () => [])
    readonly listSessions = vi.fn(async () => [])
    readonly shutdown = vi.fn(async () => {})
    readonly dispose = vi.fn()
    readonly disconnectOnly = vi.fn(async () => {})
    readonly establishLifecycleLease = vi.fn(async () => {})
    readonly onData = vi.fn(() => () => {})
    readonly onExit = vi.fn(() => () => {})
    readonly onReplay = vi.fn(() => () => {})
  }
}))

vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: vi.fn(() => localFallbackProvider),
  setLocalPtyProvider: vi.fn(),
  unbindLocalProviderListeners: vi.fn(),
  rebindLocalProviderListeners: vi.fn()
}))

vi.mock('../ipc/daemon-status-registry', () => ({ setDaemonRuntimeStatus: vi.fn() }))

vi.mock('./history-store-layout', () => ({
  prepareDaemonSessionStoreRoot: (root: string) => root
}))

vi.mock('./history-retention', () => ({ scheduleDaemonSessionHistoryGc: vi.fn() }))

function ownedPrivateDir(): { isDirectory: () => boolean; uid: number; mode: number } {
  return { isDirectory: () => true, uid: process.getuid?.() ?? 0, mode: 0o40700 }
}

// Forces process.platform for the win32-only ACL branch; callers must restore.
function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

async function importFresh() {
  vi.resetModules()
  process.env.ORCA_RUST_DAEMON_BIN = FAKE_RUST_DAEMON_BIN
  spawnerInstances.length = 0
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => ({
    pid: 12345,
    exitCode: null,
    signalCode: null,
    on() {
      return this
    },
    unref: vi.fn()
  }))
  return import('./daemon-init')
}

// Drives launchRustDaemon (the real one) through the mocked spawner's launcher.
async function launchDaemonAndReadSpawnEnv(): Promise<Record<string, string | undefined>> {
  const mod = await importFresh()
  await mod.initDaemonPtyProvider()
  const launcher = spawnerInstances[0].launcher as (
    socketPath: string,
    tokenPath: string
  ) => Promise<unknown>
  // A launch-identity mismatch with zero live sessions falls through to a fresh spawn.
  getDaemonLaunchIdentityMock.mockResolvedValueOnce('mismatch')
  await launcher('/fake/socket', '/fake/token')
  const options = spawnMock.mock.calls.at(-1)?.[2] as {
    env: Record<string, string | undefined>
  }
  return options.env
}

beforeEach(() => {
  mkdirSyncMock.mockClear()
  chmodSyncMock.mockClear()
  chmodSyncMock.mockImplementation(() => {})
  lstatSyncMock.mockReset()
  lstatSyncMock.mockImplementation(ownedPrivateDir)
  hardenSecurePathMock.mockClear()
  getDaemonLaunchIdentityMock.mockClear()
  getDaemonLaunchIdentityMock.mockResolvedValue('match')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('daemon runtime directory privacy (authority model §8 item 2)', () => {
  it('creates the runtime directory 0700, not at the umask default', async () => {
    const mod = await importFresh()

    expect(mod.getDaemonEndpointPaths().socketPath).toContain('/fake/daemon-v')
    expect(mkdirSyncMock).toHaveBeenCalledWith(FAKE_RUNTIME_DIR, {
      recursive: true,
      mode: 0o700
    })
    // Already private: nothing to tighten, so no chmod runs through the path.
    expect(chmodSyncMock).not.toHaveBeenCalled()
  })

  it('tightens a dir it owns that is merely readable (0755), after the guard', async () => {
    const mod = await importFresh()
    lstatSyncMock.mockImplementation(() => ({
      isDirectory: () => true,
      uid: process.getuid?.() ?? 0,
      mode: 0o40755
    }))

    mod.getDaemonEndpointPaths()

    expect(lstatSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      chmodSyncMock.mock.invocationCallOrder[0]
    )
    expect(chmodSyncMock).toHaveBeenCalledWith(FAKE_RUNTIME_DIR, 0o700)
  })

  it('refuses a runtime directory owned by another user', async () => {
    const mod = await importFresh()
    lstatSyncMock.mockImplementation(() => ({
      isDirectory: () => true,
      uid: (process.getuid?.() ?? 0) + 1,
      mode: 0o40700
    }))

    expect(() => mod.getDaemonEndpointPaths()).toThrow(/owned by uid/)
  })

  it('refuses a group- or other-writable runtime directory', async () => {
    const mod = await importFresh()
    lstatSyncMock.mockImplementation(() => ({
      isDirectory: () => true,
      uid: process.getuid?.() ?? 0,
      mode: 0o40707
    }))

    expect(() => mod.getDaemonEndpointPaths()).toThrow(/group\/other-writable/)
  })

  it('refuses a runtime path that is not a directory (planted symlink)', async () => {
    const mod = await importFresh()
    lstatSyncMock.mockImplementation(() => ({
      isDirectory: () => false,
      uid: process.getuid?.() ?? 0,
      mode: 0o40700
    }))

    expect(() => mod.getDaemonEndpointPaths()).toThrow(/must be a directory/)
  })

  it('hardens the ACL instead of mode bits on Windows', async () => {
    const restore = stubPlatform('win32')
    try {
      const mod = await importFresh()
      mod.getDaemonEndpointPaths()

      expect(hardenSecurePathMock).toHaveBeenCalledWith(FAKE_RUNTIME_DIR, {
        isDirectory: true,
        platform: 'win32'
      })
      // POSIX mode bits are meaningless on NTFS; userData is already per-user ACL'd.
      expect(chmodSyncMock).not.toHaveBeenCalled()
      expect(lstatSyncMock).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('daemon spawn environment (authority model §8 item 8)', () => {
  it('does not hand the daemon inherited-only env it would fork into every pane', async () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_SESSION_ID = 'poison-session-id'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'poison-entrypoint'
    process.env.NODE_ENV = 'development'
    try {
      const env = await launchDaemonAndReadSpawnEnv()

      // Verified against the real orca-daemon: a createOrAttach with no
      // envToDelete (DaemonPtyAdapter.attach's shape) spawns the pane straight
      // from this env, so a leak here reaches panes no call site can strip.
      expect(env.CLAUDECODE).toBeUndefined()
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
      expect(env.NODE_ENV).toBeUndefined()
    } finally {
      delete process.env.CLAUDECODE
      delete process.env.CLAUDE_CODE_SESSION_ID
      delete process.env.CLAUDE_CODE_ENTRYPOINT
      delete process.env.NODE_ENV
    }
  })

  it('still injects ORCA_USER_DATA_PATH and keeps unrelated inherited env', async () => {
    process.env.ORCA_SPAWN_ENV_PROBE = 'kept'
    try {
      const env = await launchDaemonAndReadSpawnEnv()

      expect(env.ORCA_USER_DATA_PATH).toBe(FAKE_USER_DATA)
      expect(env.ORCA_SPAWN_ENV_PROBE).toBe('kept')
    } finally {
      delete process.env.ORCA_SPAWN_ENV_PROBE
    }
  })
})
