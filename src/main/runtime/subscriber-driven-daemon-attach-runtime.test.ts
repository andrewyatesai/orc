/**
 * #12589 — a daemon-backed terminal whose tab was never activated in the host
 * UI was never attached, so the daemon emitted no bytes. This proves the real
 * OrcaRuntimeService seam: the first remote view subscriber of a known-but-
 * unattached local daemon session drives an attach through the pty controller.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import { OrcaRuntimeService } from './orca-runtime'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))
vi.mock('../hooks', () => ({
  createSetupRunnerScript: vi.fn(),
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})
vi.mock('../ipc/filesystem-auth', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})
vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
})

const store = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [store.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    publishRemoteBranchOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    mobileAutoRestoreFitMs: 5_000
  })
}

function createRuntime({ withAttach = true }: { withAttach?: boolean } = {}) {
  const runtime = new OrcaRuntimeService(store)
  const attach = vi.fn(async () => true)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: () => true,
    getSize: () => null,
    ...(withAttach ? { attach } : {})
  })
  return { runtime, attach }
}

/** Seed a discovered live local daemon session (connected, no SSH owner) the
 *  way inventory adoption records it — without a local spawn publishing it. */
function seedLiveLocalDaemonPty(runtime: OrcaRuntimeService, ptyId: string): void {
  ;(
    runtime as unknown as {
      ptysById: Map<string, { connectionId: string | null; connected: boolean }>
    }
  ).ptysById.set(ptyId, { connectionId: null, connected: true })
}

describe('subscriber-driven daemon attach (#12589)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('attaches a never-activated local daemon session on first remote subscribe', () => {
    const { runtime, attach } = createRuntime()
    seedLiveLocalDaemonPty(runtime, 'daemon-pty')

    runtime.registerRemoteTerminalViewSubscriber('daemon-pty', 'viewer-A')

    expect(attach).toHaveBeenCalledWith('daemon-pty')
  })

  it('attaches once across concurrent subscribers', () => {
    const { runtime, attach } = createRuntime()
    seedLiveLocalDaemonPty(runtime, 'daemon-pty')

    runtime.registerRemoteTerminalViewSubscriber('daemon-pty', 'viewer-A')
    runtime.registerRemoteTerminalViewSubscriber('daemon-pty', 'viewer-B')

    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('does not attach an SSH-scoped session (its own lease machinery owns reattach)', () => {
    const { runtime, attach } = createRuntime()
    const sshId = toAppSshPtyId('conn-1', 'daemon-pty')
    seedLiveLocalDaemonPty(runtime, sshId)

    runtime.registerRemoteTerminalViewSubscriber(sshId, 'viewer-A')

    expect(attach).not.toHaveBeenCalled()
  })

  it('does not attach a session this app spawned this generation', () => {
    const { runtime, attach } = createRuntime()
    seedLiveLocalDaemonPty(runtime, 'spawned-pty')
    // A local spawn published its provider stream this generation.
    runtime.onPtySpawned('spawned-pty', undefined, { awaitsRegistration: false })

    runtime.registerRemoteTerminalViewSubscriber('spawned-pty', 'viewer-A')

    expect(attach).not.toHaveBeenCalled()
  })

  it('subscribe still works when the controller exposes no attach', () => {
    const { runtime, attach } = createRuntime({ withAttach: false })
    seedLiveLocalDaemonPty(runtime, 'daemon-pty')

    expect(() =>
      runtime.registerRemoteTerminalViewSubscriber('daemon-pty', 'viewer-A')
    ).not.toThrow()
    expect(attach).not.toHaveBeenCalled()
  })
})
