import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

// run6-review repro: leaf.connected mirrors the renderer graph (`ptyId !== null`),
// so a restored leaf whose PTY no provider owns must be demoted from the
// controller inventory or terminal.list reports it connected/writable forever.

const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/tmp/probe-worktree'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type ControllerSession = { id: string; cwd: string; title?: string }

function makeRuntimeWithLeaf(options: {
  leafPtyId: string
  controllerSessions: ControllerSession[] | 'unavailable'
  hasPty?: (ptyId: string) => boolean | null
}): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    ...(options.hasPty ? { hasPty: options.hasPty } : {}),
    listProcesses:
      options.controllerSessions === 'unavailable'
        ? vi.fn(async () => {
            throw new Error('controller unavailable')
          })
        : vi.fn(async () => options.controllerSessions)
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: '',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: options.leafPtyId
      }
    ]
  })
  return runtime
}

describe('listTerminals liveness truth for restored leaves', () => {
  it('reports a leaf disconnected when the controller inventory proves its local ptyId absent', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-stale-from-prior-run',
      controllerSessions: []
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-stale-from-prior-run',
      connected: false,
      writable: false
    })
  })

  it('keeps a leaf connected when its ptyId is in the controller inventory', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-live-1',
      controllerSessions: [{ id: 'pty-live-1', cwd: WORKTREE_PATH }]
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-live-1',
      connected: true,
      writable: true
    })
  })

  it('never demotes on an unavailable inventory — unknown liveness is not absence', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-stale-from-prior-run',
      controllerSessions: 'unavailable'
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-stale-from-prior-run',
      connected: true,
      writable: true
    })
  })

  // Why: a just-spawned PTY can register after the inventory snapshot; the
  // provider's sync hasPty must rescue it or federation reads one
  // connected:false as exited.
  it('keeps a leaf connected when the provider synchronously knows a ptyId the snapshot missed', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-just-spawned',
      controllerSessions: [],
      hasPty: (ptyId) => ptyId === 'pty-just-spawned'
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'pty-just-spawned',
      connected: true,
      writable: true
    })
  })

  it('does not demote remote-runtime-scoped leaves the local inventory never covers', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'remote:env-1@@term_abc',
      controllerSessions: []
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'remote:env-1@@term_abc',
      connected: true,
      writable: true
    })
  })

  it('does not demote SSH-scoped leaves the aggregate inventory may not cover', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'ssh:target-1@@session-9',
      controllerSessions: []
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      ptyId: 'ssh:target-1@@session-9',
      connected: true,
      writable: true
    })
  })
})
