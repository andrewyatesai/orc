import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { FolderWorkspace, WorkspaceSessionState } from '../../shared/types'

// An agent once declared a task exited because `terminal list` came back without
// its worker: the worker was live on an SSH host, and nothing in the response
// said the listing was scoped or which host each row ran on.

const LOCAL_WORKTREE_ID = 'repo-local::/tmp/local-worktree'
const SSH_WORKTREE_ID = 'repo-ssh::/remote/ssh-worktree'
const LOCAL_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SSH_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const REMOTE_LEAF_ID = '33333333-3333-4333-8333-333333333333'

const REPOS = [
  {
    id: 'repo-local',
    path: '/tmp/local-worktree',
    displayName: 'local',
    badgeColor: '#000000',
    addedAt: 0
  },
  {
    id: 'repo-ssh',
    path: '/remote/ssh-worktree',
    displayName: 'ssh',
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: 'box-1'
  }
]

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    getWorkspaceSessionHostIds: vi.fn(() => ['local', 'ssh:box-1']),
    getFolderWorkspaces: vi.fn((): FolderWorkspace[] => []),
    getProjectGroups: vi.fn(() => []),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => REPOS),
    getRepo: vi.fn((id: string) => REPOS.find((repo) => repo.id === id)),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

type GraphLeaf = { worktreeId: string; leafId: string; ptyId: string }

function makeRuntime(leaves: GraphLeaf[], store = makeStore()): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => leaves.map((leaf) => ({ id: leaf.ptyId, cwd: '/tmp' })))
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: leaves.map((leaf, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: leaf.worktreeId,
      title: '',
      activeLeafId: leaf.leafId,
      layout: null
    })),
    leaves: leaves.map((leaf, index) => ({
      tabId: `tab-${index + 1}`,
      worktreeId: leaf.worktreeId,
      leafId: leaf.leafId,
      paneRuntimeId: index + 1,
      ptyId: leaf.ptyId,
      paneTitle: null,
      title: ''
    }))
  })
  return runtime
}

describe('listTerminals execution-host identity', () => {
  it('names the SSH connection a remote terminal runs on instead of local', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: LOCAL_LEAF_ID, ptyId: 'pty-local-1' },
      { worktreeId: SSH_WORKTREE_ID, leafId: SSH_LEAF_ID, ptyId: 'ssh:box-1@@pty-7' }
    ])

    const { terminals } = await runtime.listTerminals()

    const sshRow = terminals.find((terminal) => terminal.ptyId === 'ssh:box-1@@pty-7')
    const localRow = terminals.find((terminal) => terminal.ptyId === 'pty-local-1')
    expect(sshRow?.executionHostId).toBe('ssh:box-1')
    expect(localRow?.executionHostId).toBe('local')
  })

  it('names the paired runtime environment a mirrored terminal belongs to', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: REMOTE_LEAF_ID, ptyId: 'remote:env-7@@handle-1' }
    ])

    const { terminals } = await runtime.listTerminals()

    expect(terminals[0]?.executionHostId).toBe('runtime:env-7')
  })

  it('leaves the host unset — never local — for a paired PTY that names no environment', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: REMOTE_LEAF_ID, ptyId: 'remote:handle-1' }
    ])

    const { hostScope, terminals } = await runtime.listTerminals()

    expect(terminals[0]?.executionHostId).toBeUndefined()
    expect(hostScope?.hostIds).toEqual(['local'])
  })

  it.each([
    'remote:env@@%E0%A4%A',
    'remote:%20@@terminal%3Aone',
    'ssh:%E0%A4%A@@pty-7',
    'ssh:%20@@pty-7'
  ])('leaves the host unset for a malformed foreign PTY id: %s', async (ptyId) => {
    const runtime = makeRuntime([{ worktreeId: LOCAL_WORKTREE_ID, leafId: REMOTE_LEAF_ID, ptyId }])

    const { hostScope, terminals } = await runtime.listTerminals()

    expect(terminals[0]?.executionHostId).toBeUndefined()
    expect(hostScope?.hostIds).toEqual(['local'])
  })
})

describe('listTerminals scope declaration', () => {
  it('declares every host an unscoped listing covers', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: LOCAL_LEAF_ID, ptyId: 'pty-local-1' },
      { worktreeId: SSH_WORKTREE_ID, leafId: SSH_LEAF_ID, ptyId: 'ssh:box-1@@pty-7' }
    ])

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local', 'ssh:box-1'])
    expect(result.hostScope?.omittedHostIds).toEqual([])
  })

  it('does not claim a paired runtime was covered from a mirrored row', async () => {
    const runtime = makeRuntime([
      { worktreeId: LOCAL_WORKTREE_ID, leafId: REMOTE_LEAF_ID, ptyId: 'remote:env-7@@handle-1' }
    ])

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['runtime:env-7', 'ssh:box-1'])
  })

  it('keeps a disconnected SSH host omitted when only local inventory answered', async () => {
    const runtime = makeRuntime([])
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => [])
    } as never)

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['ssh:box-1'])
  })

  it('marks every known host omitted when process inventory is unverifiable', async () => {
    const runtime = makeRuntime([])
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'never' })),
      write: () => true,
      kill: () => true,
      listProcesses: vi.fn(async () => {
        throw new Error('relay unavailable')
      })
    } as never)

    const result = await runtime.listTerminals()

    expect(result.hostScope?.hostIds).toEqual([])
    expect(result.hostScope?.omittedHostIds).toEqual(['local', 'ssh:box-1'])
  })

  it('reports the hosts a worktree-scoped listing skipped, so an empty result is not absolute', async () => {
    const runtime = makeRuntime([
      { worktreeId: SSH_WORKTREE_ID, leafId: SSH_LEAF_ID, ptyId: 'ssh:box-1@@pty-7' }
    ])

    const result = await runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)

    expect(result.terminals).toEqual([])
    expect(result.hostScope?.hostIds).toEqual(['local'])
    expect(result.hostScope?.omittedHostIds).toEqual(['ssh:box-1'])
  })
})
