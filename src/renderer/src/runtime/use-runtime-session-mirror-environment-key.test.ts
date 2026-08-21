// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallow } from 'zustand/shallow'
import { getDefaultSettings } from '../../../shared/constants'
import type { ProjectGroup, Repo } from '../../../shared/types'
import type * as RuntimeSessionMirrorOwnersModule from '@/lib/runtime-session-mirror-owners'
import { makeWorktree } from '@/store/slices/store-test-helpers'

const { getMirrorIds } = vi.hoisted(() => ({ getMirrorIds: vi.fn() }))

vi.mock('@/lib/runtime-session-mirror-owners', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeSessionMirrorOwnersModule>()
  getMirrorIds.mockImplementation(actual.getRuntimeSessionMirrorEnvironmentIds)
  return { ...actual, getRuntimeSessionMirrorEnvironmentIds: getMirrorIds }
})

import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import {
  selectRuntimeSessionMirrorKeyInputs,
  useRuntimeSessionMirrorEnvironmentKey
} from './use-runtime-session-mirror-environment-key'
import { useWebSessionTabsSync } from './web-session-tabs-sync'

const initialState = useAppStore.getInitialState()
const SEP = String.fromCharCode(1)

function makeRepo(id: string, executionHostId: Repo['executionHostId']): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    connectionId: null,
    executionHostId
  }
}

function makeProjectGroup(executionHostId: ProjectGroup['executionHostId']): ProjectGroup {
  return {
    id: 'group-b',
    name: 'Group B',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    connectionId: null,
    executionHostId
  }
}

function seedMirrorState(): void {
  useAppStore.setState(
    {
      ...initialState,
      settings: {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'env-a'
      },
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      runtimeEnvironments: [
        { id: 'env-a', createdAt: 100, pairingRevision: 101 },
        { id: 'env-b', createdAt: 200, pairingRevision: 201 }
      ] as PublicKnownRuntimeEnvironment[],
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }],
        ['env-b', { status: { runtimeId: 'runtime-b' }, connectionGeneration: 2 }]
      ]) as unknown as AppState['runtimeStatusByEnvironmentId']
    },
    true
  )
}

describe('useRuntimeSessionMirrorEnvironmentKey', () => {
  beforeEach(() => {
    getMirrorIds.mockClear()
    seedMirrorState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('does not rescan remote ownership for unrelated store writes or parent renders', () => {
    const repos = Array.from({ length: 100 }, (_, index) =>
      makeRepo(`repo-${index}`, 'runtime:env-a')
    )
    const worktreesByRepo: AppState['worktreesByRepo'] = Object.fromEntries(
      repos.map((repo) => [
        repo.id,
        [makeWorktree({ id: `${repo.id}::worktree`, repoId: repo.id, hostId: 'runtime:env-a' })]
      ])
    )
    useAppStore.setState({ repos, worktreesByRepo })
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKey())
    const initialCallCount = getMirrorIds.mock.calls.length

    expect(hook.result.current).toBe(`env-a${SEP}runtime-a${SEP}1${SEP}101`)
    expect(initialCallCount).toBe(1)

    act(() => {
      for (let index = 0; index < 100; index += 1) {
        useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
      }
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings!,
          terminalFontSize: useAppStore.getState().settings!.terminalFontSize + 1
        }
      })
    })
    hook.rerender()

    expect(getMirrorIds).toHaveBeenCalledTimes(initialCallCount)
  })

  it('keeps the production session sync off the hot store-write path', () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    const initialCallCount = getMirrorIds.mock.calls.length

    expect(initialCallCount).toBe(1)
    act(() => {
      useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
      useAppStore.setState({ sortEpoch: useAppStore.getState().sortEpoch + 1 })
    })
    hook.rerender()

    expect(getMirrorIds).toHaveBeenCalledTimes(initialCallCount)
  })

  it.each([
    {
      source: 'active environment',
      change: (state: AppState): Partial<AppState> => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'env-b' }
      })
    },
    {
      source: 'repository host',
      change: (): Partial<AppState> => ({ repos: [makeRepo('repo-b', 'runtime:env-b')] })
    },
    {
      source: 'published worktree owner',
      change: (): Partial<AppState> => ({
        worktreesByRepo: {
          'repo-b': [
            makeWorktree({
              id: 'repo-b::worktree',
              repoId: 'repo-b',
              hostId: 'ssh:private',
              runtimeOwnerEnvironmentId: 'env-b'
            })
          ]
        }
      })
    },
    {
      source: 'detected worktree owner',
      change: (): Partial<AppState> => ({
        detectedWorktreesByRepo: {
          'repo-b': {
            repoId: 'repo-b',
            authoritative: true,
            source: 'git',
            worktrees: [
              {
                ...makeWorktree({
                  id: 'repo-b::detected',
                  repoId: 'repo-b',
                  hostId: 'ssh:private',
                  runtimeOwnerEnvironmentId: 'env-b'
                }),
                ownership: 'external',
                selectedCheckout: false,
                visible: true
              }
            ]
          }
        }
      })
    },
    {
      source: 'project group host',
      change: (): Partial<AppState> => ({ projectGroups: [makeProjectGroup('runtime:env-b')] })
    },
    {
      source: 'restored session host',
      change: (): Partial<AppState> => ({
        restoredRuntimeHostIdByWorkspaceSessionKey: { 'folder:restored': 'runtime:env-b' }
      })
    }
  ])('rebuilds when the $source references an online runtime', ({ change }) => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, activeRuntimeEnvironmentId: null }
    })
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKey())

    expect(hook.result.current).toBe('')
    act(() => useAppStore.setState(change(useAppStore.getState())))

    expect(hook.result.current).toBe(`env-b${SEP}runtime-b${SEP}2${SEP}201`)
    expect(getMirrorIds).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the key when connection or pairing identity changes', () => {
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKey())

    act(() => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['env-a', { status: { runtimeId: 'runtime-a' }, connectionGeneration: 2 }]
        ]) as unknown as AppState['runtimeStatusByEnvironmentId']
      })
    })
    expect(hook.result.current).toBe(`env-a${SEP}runtime-a${SEP}2${SEP}101`)

    act(() => {
      useAppStore.setState({
        runtimeEnvironments: [
          { id: 'env-a', createdAt: 100, pairingRevision: 102 }
        ] as PublicKnownRuntimeEnvironment[]
      })
    })
    expect(hook.result.current).toBe(`env-a${SEP}runtime-a${SEP}2${SEP}102`)
    expect(getMirrorIds).toHaveBeenCalledTimes(3)
  })

  it('invalidates only for state the mirror scan actually reads', () => {
    const state = useAppStore.getState()
    const selected = selectRuntimeSessionMirrorKeyInputs(state)
    const unrelated = selectRuntimeSessionMirrorKeyInputs({
      ...state,
      agentStatusEpoch: state.agentStatusEpoch + 1,
      settings: { ...state.settings!, terminalFontSize: state.settings!.terminalFontSize + 1 }
    })

    expect(shallow(selected, unrelated)).toBe(true)

    const relevantChanges: Partial<AppState>[] = [
      { settings: { ...state.settings!, activeRuntimeEnvironmentId: 'env-b' } },
      { repos: [...state.repos] },
      { worktreesByRepo: { ...state.worktreesByRepo } },
      { detectedWorktreesByRepo: { ...state.detectedWorktreesByRepo } },
      { projectGroups: [...state.projectGroups] },
      {
        restoredRuntimeHostIdByWorkspaceSessionKey: {
          ...state.restoredRuntimeHostIdByWorkspaceSessionKey
        }
      },
      { runtimeEnvironments: [...state.runtimeEnvironments] },
      { runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId) }
    ]
    for (const change of relevantChanges) {
      expect(
        shallow(selected, selectRuntimeSessionMirrorKeyInputs({ ...state, ...change } as AppState))
      ).toBe(false)
    }
  })
})
