import { describe, expect, it } from 'vitest'
import { ptyBelongsToTeardownFence } from './worktree-teardown-host-fence'

describe('ptyBelongsToTeardownFence', () => {
  it('admits every host when no fence is set (non-destructive sweep)', () => {
    expect(ptyBelongsToTeardownFence('ssh-1', undefined)).toBe(true)
    expect(ptyBelongsToTeardownFence(null, undefined)).toBe(true)
  })

  it('admits only the named SSH connection', () => {
    const fence = { resolvedWorktreeId: 'repo::/wt', resolvedConnectionId: 'ssh-1' }
    expect(ptyBelongsToTeardownFence('ssh-1', fence)).toBe(true)
    // The same-id local (or other-connection) copy must survive the sweep.
    expect(ptyBelongsToTeardownFence(null, fence)).toBe(false)
    expect(ptyBelongsToTeardownFence('ssh-2', fence)).toBe(false)
  })

  it('fences to the local host when no connection is named', () => {
    const fence = { resolvedWorktreeId: 'repo::/wt' }
    expect(ptyBelongsToTeardownFence(null, fence)).toBe(true)
    expect(ptyBelongsToTeardownFence('ssh-1', fence)).toBe(false)
  })
})
