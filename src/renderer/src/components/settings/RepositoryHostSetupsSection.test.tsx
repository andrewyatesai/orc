// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getExecutionHostLabel, toSshExecutionHostId } from '../../../../shared/execution-host'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'

let container: HTMLDivElement
let root: Root

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName' | 'path'>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

function makeProject({ id, ...overrides }: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    id,
    displayName: 'Orca',
    badgeColor: '#737373',
    sourceRepoIds: ['local-repo', 'remote-repo'],
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

function makeSetup(
  overrides: Partial<ProjectHostSetup> &
    Pick<ProjectHostSetup, 'id' | 'projectId' | 'repoId' | 'hostId' | 'path'>
): ProjectHostSetup {
  return {
    displayName: 'Orca',
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function renderSection(repo: Repo, selectedProjectSetupId?: string): void {
  act(() => {
    root.render(
      React.createElement(RepositoryHostSetupsSection, {
        repo,
        selectedProjectSetupId,
        forceVisible: true,
        searchQuery: '',
        searchEntries: []
      })
    )
  })
}

function findButton(label: string): HTMLButtonElement | undefined {
  const buttons = Array.from(container.querySelectorAll('button'))
  return (
    buttons.find((button) => button.textContent?.trim() === label) ??
    buttons.find((button) => button.textContent?.includes(label))
  )
}

describe('RepositoryHostSetupsSection', () => {
  it('shows a viewing-host selector when the project has multiple settings-backed hosts', () => {
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/userhome/alice/orca'
    })
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/home/alice/orca',
      connectionId: 'openclaw 2'
    })
    useAppStore.setState({
      repos: [localRepo, remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/userhome/alice/orca'
        }),
        makeSetup({
          id: 'remote-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: toSshExecutionHostId('openclaw 2'),
          path: '/home/alice/orca'
        })
      ],
      sshTargetLabels: new Map([['openclaw 2', 'openclaw 2']])
    })

    renderSection(localRepo)

    expect(container.textContent).toContain('Viewing host')
    expect(container.textContent).toContain(LOCAL_HOST_LABEL)
  })

  it('selects the host in place instead of navigating to a separate repo pane', () => {
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    const setSettingsProjectHostSelection = vi.fn()
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/userhome/alice/orca'
    })
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/home/alice/orca',
      connectionId: 'openclaw 2'
    })
    useAppStore.setState({
      repos: [localRepo, remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/userhome/alice/orca'
        }),
        makeSetup({
          id: 'remote-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: toSshExecutionHostId('openclaw 2'),
          path: '/home/alice/orca'
        })
      ],
      openSettingsPage,
      openSettingsTarget,
      setSettingsProjectHostSelection
    })

    renderSection(localRepo)

    expect(container.textContent).toContain('openclaw 2')
    const openButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open'
    )
    expect(openButton).toBeTruthy()

    act(() => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The single project pane switches host in place — no navigation.
    expect(setSettingsProjectHostSelection).toHaveBeenCalledWith(
      'github:stablyai/orca',
      toSshExecutionHostId('openclaw 2'),
      'remote-repo'
    )
    expect(openSettingsPage).not.toHaveBeenCalled()
    expect(openSettingsTarget).not.toHaveBeenCalled()
  })

  it('keeps nested SSH setups distinct and derives readiness from their HUB owner', () => {
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/srv/orca',
      executionHostId: 'runtime:hub'
    })
    useAppStore.setState({
      repos: [remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca', sourceRepoIds: ['remote-repo'] })],
      projectHostSetups: [
        makeSetup({
          id: 'direct-setup',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: 'runtime:hub',
          executionHostId: 'ssh:direct',
          runtimeOwnerEnvironmentId: 'hub',
          path: '/srv/orca'
        }),
        makeSetup({
          id: 'jump-setup',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: 'runtime:hub',
          executionHostId: 'ssh:jump',
          runtimeOwnerEnvironmentId: 'hub',
          path: '/srv/orca'
        })
      ],
      runtimeStatusByEnvironmentId: new Map([
        [
          'hub',
          {
            checkedAt: 1,
            appVersion: '1.8.0',
            status: {
              runtimeId: 'runtime-hub',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: []
            }
          }
        ]
      ]),
      sshStateByEnvironment: new Map([
        [
          'hub',
          {
            connectionStates: new Map([
              [
                'direct',
                {
                  targetId: 'direct',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0
                }
              ],
              [
                'jump',
                {
                  targetId: 'jump',
                  status: 'disconnected',
                  error: null,
                  reconnectAttempt: 0
                }
              ]
            ]),
            targetLabels: new Map([
              ['direct', 'Direct box'],
              ['jump', 'Jump box']
            ]),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    })

    renderSection(remoteRepo, 'jump-setup')

    expect(container.textContent).toContain('Direct box')
    expect(container.textContent).toContain('Jump box')
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).toContain('Disconnected')
    expect(findButton('Open')).toBeTruthy()
    const currentSetup = container.querySelector('[data-current="true"]')
    expect(currentSetup?.textContent).toContain('Jump box')
    expect(currentSetup?.textContent).toContain('Disconnected')
    expect(currentSetup?.textContent).not.toContain('Direct box')
    expect(currentSetup?.textContent).not.toContain('Ready')
  })

  it('shows HUB-local setups as disconnected when their owning runtime is unreachable', () => {
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/srv/orca',
      executionHostId: 'runtime:hub'
    })
    useAppStore.setState({
      repos: [remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca', sourceRepoIds: ['remote-repo'] })],
      projectHostSetups: [
        makeSetup({
          id: 'hub-local-setup',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: 'runtime:hub',
          executionHostId: 'local',
          runtimeOwnerEnvironmentId: 'hub',
          path: '/srv/orca'
        })
      ],
      runtimeStatusByEnvironmentId: new Map([['hub', { checkedAt: 1, status: null }]])
    })

    renderSection(remoteRepo)

    expect(container.textContent).toContain('Disconnected')
    expect(container.textContent).not.toContain('Ready')
  })

  it('removes independent setup metadata instead of opening an empty repo target', async () => {
    const deleteProjectHostSetup = vi.fn().mockResolvedValue({
      project: makeProject({ id: 'github:stablyai/orca' }),
      setup: makeSetup({
        id: 'gpu-setup',
        projectId: 'github:stablyai/orca',
        repoId: '',
        hostId: 'runtime:gpu',
        path: ''
      })
    })
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/userhome/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/userhome/alice/orca'
        }),
        makeSetup({
          id: 'gpu-setup',
          projectId: 'github:stablyai/orca',
          repoId: '',
          hostId: 'runtime:gpu',
          path: '',
          setupState: 'setting-up',
          setupMethod: 'provisioned'
        })
      ],
      openSettingsPage,
      openSettingsTarget,
      deleteProjectHostSetup
    })

    renderSection(localRepo)

    expect(container.textContent).toContain('Path pending')
    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove'
    )
    expect(removeButton).toBeTruthy()

    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(deleteProjectHostSetup).toHaveBeenCalledWith({
      setupId: 'gpu-setup',
      hostId: 'runtime:gpu'
    })
    expect(openSettingsPage).not.toHaveBeenCalled()
    expect(openSettingsTarget).not.toHaveBeenCalled()
  })

  it('removes the selected same-id setup from its host', async () => {
    const deleteProjectHostSetup = vi.fn().mockResolvedValue({
      project: makeProject({ id: 'github:stablyai/orca' }),
      setup: makeSetup({
        id: 'shared-setup',
        projectId: 'github:stablyai/orca',
        repoId: '',
        hostId: 'runtime:cpu',
        path: ''
      })
    })
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/userhome/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/userhome/alice/orca'
        }),
        makeSetup({
          id: 'shared-setup',
          projectId: 'github:stablyai/orca',
          repoId: '',
          hostId: 'runtime:gpu',
          path: '',
          setupState: 'setting-up',
          setupMethod: 'provisioned'
        }),
        makeSetup({
          id: 'shared-setup',
          projectId: 'github:stablyai/orca',
          repoId: '',
          hostId: 'runtime:cpu',
          path: '',
          setupState: 'setting-up',
          setupMethod: 'provisioned'
        })
      ],
      deleteProjectHostSetup
    })

    renderSection(localRepo)

    const removeButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Remove'
    )
    expect(removeButtons).toHaveLength(2)

    await act(async () => {
      removeButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(deleteProjectHostSetup).toHaveBeenCalledWith({
      setupId: 'shared-setup',
      hostId: 'runtime:cpu'
    })
  })
})
