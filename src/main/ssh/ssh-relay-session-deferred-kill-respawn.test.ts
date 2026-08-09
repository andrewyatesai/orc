/**
 * The deferred-kill leak that ordinary pane reuse reopened: a pane closed while
 * the relay was unreachable records killRequestedAt on its lease, then the user
 * opens a new pane in the SAME leaf before the reaper ever runs. These drive the
 * REAL Store against the REAL reaper — only the SSH hop and the relay's process
 * list are mocked, since neither is reachable from unit scope.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'
import type { Store } from '../persistence'

const { muxRequestMock } = vi.hoisted(() => ({ muxRequestMock: vi.fn() }))
const dataDir = { path: '' }

vi.mock('electron', () => ({
  app: { getPath: () => dataDir.path },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))
vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
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

const { getSshPtyProvider, getPtyIdsForConnection } = await import('../ipc/pty')

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const tempDirs: string[] = []

async function createRealStore(): Promise<Store> {
  dataDir.path = mkdtempSync(join(tmpdir(), 'orca-deferred-kill-'))
  tempDirs.push(dataDir.path)
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

function spawnPane(store: Store, ptyId: string, incarnationId: string, leafId = LEAF): void {
  store.upsertSshRemotePtyLease({
    targetId: 'target-1',
    worktreeId: 'wt1',
    tabId: 'tab1',
    leafId,
    ptyId,
    incarnationId,
    state: 'attached'
  })
}

/** What ipc/pty does when a pane closes with no reachable relay. */
function closePaneWhileUnreachable(store: Store, ptyId: string): void {
  expect(store.recordSshRemotePtyKillIntent('target-1', ptyId)).toBe(true)
  store.markSshRemotePtyLease('target-1', ptyId, 'terminated')
}

function relayReporting(sessions: { id: string; incarnationId?: string }[]): {
  shutdown: ReturnType<typeof vi.fn>
  attachForReconnect: ReturnType<typeof vi.fn>
} {
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const attachForReconnect = vi.fn().mockResolvedValue({})
  vi.mocked(getSshPtyProvider).mockReturnValue({
    attachForReconnect,
    listProcesses: vi.fn().mockResolvedValue(sessions),
    shutdown,
    dispose: vi.fn()
  } as unknown as ReturnType<typeof getSshPtyProvider>)
  return { shutdown, attachForReconnect }
}

function leaseFor(store: Store, ptyId: string) {
  return store.getSshRemotePtyLeases('target-1').find((lease) => lease.ptyId === ptyId)
}

describe('deferred remote kill across a same-leaf respawn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reaps the orphaned shell and leaves the leaf its new pane', async () => {
    const store = await createRealStore()
    spawnPane(store, 'pty-1', 'inc-orphan')
    closePaneWhileUnreachable(store, 'pty-1')
    // Reuse: a new pane in the same leaf, still before any reconnect.
    spawnPane(store, 'pty-2', 'inc-live')
    const { shutdown, attachForReconnect } = relayReporting([
      { id: 'ssh:target-1@@pty-1', incarnationId: 'inc-orphan' },
      { id: 'ssh:target-1@@pty-2', incarnationId: 'inc-live' }
    ])
    const { mockConn, mockPortForward, getMainWindow } = createMockDeps()

    await new SshRelaySession('target-1', getMainWindow, store, mockPortForward).establish(mockConn)

    expect(shutdown.mock.calls).toEqual([
      ['ssh:target-1@@pty-1', { immediate: true, keepHistory: false }]
    ])
    // The retained tombstone must stay dead: reconnect reattaches only the live pane.
    expect(attachForReconnect.mock.calls.map(([ptyId]) => ptyId)).toEqual(['pty-2'])
    expect(leaseFor(store, 'pty-1')).not.toHaveProperty('killRequestedAt')
    expect(leaseFor(store, 'pty-2')).toEqual(
      expect.objectContaining({ incarnationId: 'inc-live', leafId: LEAF })
    )
  })

  it('kills nothing when the relay hands the orphan id to another pane', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const store = await createRealStore()
      spawnPane(store, 'pty-1', 'inc-orphan')
      closePaneWhileUnreachable(store, 'pty-1')
      // A restarted relay reset its pty-N counter, so pty-1 is someone else's pane now.
      spawnPane(store, 'pty-1', 'inc-somebody-else', OTHER_LEAF)
      const { shutdown } = relayReporting([
        { id: 'ssh:target-1@@pty-1', incarnationId: 'inc-somebody-else' }
      ])
      const { mockConn, mockPortForward, getMainWindow } = createMockDeps()

      await new SshRelaySession('target-1', getMainWindow, store, mockPortForward).establish(
        mockConn
      )

      expect(shutdown).not.toHaveBeenCalled()
      expect(leaseFor(store, 'pty-1')).toEqual(
        expect.objectContaining({ incarnationId: 'inc-somebody-else', state: 'attached' })
      )
    } finally {
      warn.mockRestore()
    }
  })
})
