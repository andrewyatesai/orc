import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

// Scoped-by-host preserved-branch cleanup needs the removal/force-delete hostId
// to survive the real RPC dispatch, not just a hand-built runtime double.
function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('worktree preserved-branch host routing', () => {
  it('threads the removal hostId through worktree.rm so cleanup stays host-scoped', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.rm', {
        worktree: 'id:wt-1',
        hostId: 'ssh:hub-target',
        runHooks: true
      })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      false,
      true,
      false,
      'ssh:hub-target'
    )
  })

  it('omits hostId on worktree.rm when the caller has none', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(makeRequest('worktree.rm', { worktree: 'id:wt-1', runHooks: true }))

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-1', false, true, false)
  })

  it('routes worktree.forceDeleteBranch with its hostId to the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.forceDeleteBranch', {
        worktree: 'id:wt-1',
        branchName: 'feature/keep',
        expectedHead: 'abc1234',
        hostId: 'ssh:hub-target'
      })
    )

    expect(runtime.forceDeletePreservedBranch).toHaveBeenCalledWith(
      'id:wt-1',
      'feature/keep',
      'abc1234',
      'ssh:hub-target'
    )
    expect(response).toMatchObject({ ok: true, result: { deleted: true } })
  })

  it('omits hostId on worktree.forceDeleteBranch when the caller has none', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.forceDeleteBranch', {
        worktree: 'id:wt-1',
        branchName: 'feature/keep',
        expectedHead: 'abc1234'
      })
    )

    expect(runtime.forceDeletePreservedBranch).toHaveBeenCalledWith(
      'id:wt-1',
      'feature/keep',
      'abc1234'
    )
  })
})
