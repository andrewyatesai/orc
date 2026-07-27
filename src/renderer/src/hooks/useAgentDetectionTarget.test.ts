import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from './useAgentDetectionTarget'

type OwnerState = Parameters<typeof getAgentDetectionTargetKeyForWorktree>[0]

function makeState(overrides: Record<string, unknown>): OwnerState {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    worktreesByRepo: {},
    ...overrides
  } as unknown as OwnerState
}

describe('getAgentDetectionTargetKeyForWorktree', () => {
  it('routes an SSH-owned worktree to its connection host', () => {
    const state = makeState({
      repos: [{ id: 'repo-1', connectionId: 'ssh-1' }],
      worktreesByRepo: { 'repo-1': [{ id: 'repo-1::wt', repoId: 'repo-1' }] }
    })

    expect(getAgentDetectionTargetKeyForWorktree(state, 'repo-1::wt')).toBe('ssh:ssh-1')
  })

  it('routes a paired-runtime worktree to its runtime host, not the local client (#9790)', () => {
    // Repro for the "Remote Server lists local agents" bug: a worktree owned by
    // a paired runtime must resolve to that runtime, never fall back to local.
    const state = makeState({
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: {
        'repo-1': [{ id: 'repo-1::wt', repoId: 'repo-1', hostId: 'runtime:env-1' }]
      }
    })

    expect(getAgentDetectionTargetKeyForWorktree(state, 'repo-1::wt')).toBe('runtime:env-1')
  })

  it('routes a plain local worktree to the local host', () => {
    const state = makeState({
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'repo-1::wt', repoId: 'repo-1' }] }
    })

    expect(getAgentDetectionTargetKeyForWorktree(state, 'repo-1::wt')).toBe('local')
  })

  it('stays unresolved while the owning repo has not hydrated', () => {
    expect(getAgentDetectionTargetKeyForWorktree(makeState({}), 'repo-1::wt')).toBeUndefined()
  })

  it('uses an explicit runtime owner without scanning ambiguous child SSH repos', () => {
    let projectGroupReads = 0
    const repos = Array.from({ length: 100 }, (_, index) => {
      const repo = {
        id: `repo-${index}`,
        connectionId: `ssh-${index}`,
        executionHostId: `ssh:ssh-${index}`,
        path: `/workspace/repo-${index}`
      }
      Object.defineProperty(repo, 'projectGroupId', {
        enumerable: true,
        get: () => {
          projectGroupReads += 1
          return 'runtime-group'
        }
      })
      return repo
    })
    const state = makeState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      folderWorkspaces: [
        {
          id: 'runtime-folder',
          projectGroupId: 'runtime-group',
          folderPath: '/workspace'
        }
      ],
      projectGroups: [
        {
          id: 'runtime-group',
          connectionId: null,
          executionHostId: 'runtime:owner-env'
        }
      ],
      repos
    })

    expect(getAgentDetectionTargetKeyForWorktree(state, folderWorkspaceKey('runtime-folder'))).toBe(
      'runtime:owner-env'
    )
    expect(projectGroupReads).toBe(0)
  })

  it('stays unresolved when ownership records have not hydrated', () => {
    const state = makeState({ settings: { activeRuntimeEnvironmentId: 'focused-env' } })

    expect(getAgentDetectionTargetKeyForWorktree(state, 'missing-worktree')).toBeUndefined()
  })

  it('does not trust a repo owner before the requested worktree hydrates', () => {
    const state = makeState({
      repos: [
        {
          id: 'repo-1',
          connectionId: null,
          executionHostId: 'local'
        }
      ]
    })

    expect(getAgentDetectionTargetKeyForWorktree(state, 'repo-1::/remote/worktree')).toBeUndefined()
  })

  it('keeps the active runtime fallback for hydrated legacy worktrees', () => {
    const state = makeState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: null }],
      worktreesByRepo: {
        'repo-1': [{ id: 'repo-1::worktree-1', repoId: 'repo-1' }]
      }
    })

    expect(getAgentDetectionTargetKeyForWorktree(state, 'repo-1::worktree-1')).toBe('runtime:env-1')
  })

  it('builds one owner index per cold worktree and repo snapshot', () => {
    let worktreeIdReads = 0
    let repoIdReads = 0
    const repos = Array.from({ length: 100 }, (_, index) => {
      const repo = {
        connectionId: null,
        executionHostId: 'local'
      }
      Object.defineProperty(repo, 'id', {
        enumerable: true,
        get: () => {
          repoIdReads += 1
          return `repo-${index}`
        }
      })
      return repo
    })
    const worktrees = Array.from({ length: 100 }, (_, index) => {
      const worktree = {
        repoId: `repo-${index}`,
        hostId: undefined
      }
      Object.defineProperty(worktree, 'id', {
        enumerable: true,
        get: () => {
          worktreeIdReads += 1
          return `worktree-${index}`
        }
      })
      return worktree
    })
    const state = makeState({ repos, worktreesByRepo: { all: worktrees } })

    expect(getAgentDetectionTargetKeyForWorktree(state, 'worktree-99')).toBe('local')
    expect(worktreeIdReads).toBe(100)
    expect(repoIdReads).toBe(100)
  })
})

describe('parseAgentDetectionTargetKey', () => {
  it('maps each key form back to a detection target', () => {
    expect(parseAgentDetectionTargetKey(undefined)).toBeUndefined()
    expect(parseAgentDetectionTargetKey('local')).toEqual({ kind: 'local' })
    expect(parseAgentDetectionTargetKey('ssh:ssh-1')).toEqual({
      kind: 'ssh',
      connectionId: 'ssh-1'
    })
    expect(parseAgentDetectionTargetKey('runtime:env-1')).toEqual({
      kind: 'runtime',
      environmentId: 'env-1'
    })
  })
})
