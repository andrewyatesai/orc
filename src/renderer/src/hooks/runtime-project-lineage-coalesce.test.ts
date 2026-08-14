import { describe, expect, it, vi } from 'vitest'
import {
  refreshRuntimeProjectWorktrees,
  refreshRuntimeProjectWorktreesAndLineage
} from './runtime-project-lineage-coalesce'

describe('refreshRuntimeProjectWorktrees', () => {
  it('suppresses the per-repo lineage pass and scopes each fetch to its owning host', async () => {
    const fetchWorktrees = vi.fn().mockResolvedValue(true)

    await refreshRuntimeProjectWorktrees(
      [
        { id: 'repo-1', executionHostId: 'runtime:env-1' },
        { id: 'repo-2', connectionId: 'conn-1' }
      ],
      fetchWorktrees
    )

    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      ownerHostId: 'runtime:env-1',
      suppressRemoteLineageRefresh: true
    })
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-2', {
      ownerHostId: 'ssh:conn-1',
      suppressRemoteLineageRefresh: true
    })
  })

  it('collapses per-repo failures into one AggregateError naming the failed repos', async () => {
    const error = new Error('repo refresh failed')
    const fetchWorktrees = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(error)

    const rejection = await refreshRuntimeProjectWorktrees(
      [{ id: 'repo-1' }, { id: 'repo-2' }],
      fetchWorktrees
    ).catch((thrown: unknown) => thrown)

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).message).toBe(
      'Failed to refresh 1 runtime project worktree(s): repo-2'
    )
    expect((rejection as AggregateError).errors).toEqual([error])
  })

  it('resolves without probing when there are no repos', async () => {
    const fetchWorktrees = vi.fn()
    await expect(refreshRuntimeProjectWorktrees([], fetchWorktrees)).resolves.toBeUndefined()
    expect(fetchWorktrees).not.toHaveBeenCalled()
  })
})

describe('refreshRuntimeProjectWorktreesAndLineage', () => {
  it('runs the final lineage refresh after the bulk worktree refresh', async () => {
    const order: string[] = []
    const refreshWorktrees = vi.fn(async () => {
      order.push('worktrees')
    })
    const refreshLineage = vi.fn(async () => {
      order.push('lineage')
    })

    await refreshRuntimeProjectWorktreesAndLineage(refreshWorktrees, refreshLineage)

    expect(order).toEqual(['worktrees', 'lineage'])
    expect(refreshLineage).toHaveBeenCalledTimes(1)
  })

  it('still runs the final lineage refresh when the bulk refresh fails', async () => {
    const worktreeError = new Error('bulk refresh failed')
    const refreshWorktrees = vi.fn().mockRejectedValue(worktreeError)
    const refreshLineage = vi.fn().mockResolvedValue(undefined)

    const rejection = await refreshRuntimeProjectWorktreesAndLineage(
      refreshWorktrees,
      refreshLineage
    ).catch((thrown: unknown) => thrown)

    // Why: a failed repo refresh must not strand the host-wide lineage snapshot.
    expect(refreshLineage).toHaveBeenCalledTimes(1)
    expect(rejection).toBe(worktreeError)
  })

  it('retains both the bulk and the lineage failure', async () => {
    const worktreeError = new Error('bulk refresh failed')
    const lineageError = new Error('lineage refresh failed')
    const refreshWorktrees = vi.fn().mockRejectedValue(worktreeError)
    const refreshLineage = vi.fn().mockRejectedValue(lineageError)

    const rejection = await refreshRuntimeProjectWorktreesAndLineage(
      refreshWorktrees,
      refreshLineage
    ).catch((thrown: unknown) => thrown)

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors).toEqual([worktreeError, lineageError])
  })

  it('rethrows a lineage failure when the bulk refresh succeeded', async () => {
    const lineageError = new Error('lineage refresh failed')
    const refreshWorktrees = vi.fn().mockResolvedValue(undefined)
    const refreshLineage = vi.fn().mockRejectedValue(lineageError)

    const rejection = await refreshRuntimeProjectWorktreesAndLineage(
      refreshWorktrees,
      refreshLineage
    ).catch((thrown: unknown) => thrown)

    expect(rejection).toBe(lineageError)
  })
})
