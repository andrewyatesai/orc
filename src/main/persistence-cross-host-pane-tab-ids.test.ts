import { describe, expect, it } from 'vitest'
import type { PersistedState, WorkspaceSessionState } from '../shared/types'
import { findCrossHostPaneTabIds, withoutPaneTabIds } from './persistence-cross-host-pane-tab-ids'

function sessionWithTabs(...tabIds: string[]): WorkspaceSessionState {
  return {
    terminalLayoutsByTabId: Object.fromEntries(tabIds.map((tabId) => [tabId, {}]))
  } as unknown as WorkspaceSessionState
}

function stateWith(
  local: WorkspaceSessionState,
  byHost?: Record<string, WorkspaceSessionState>
): PersistedState {
  return {
    workspaceSession: local,
    workspaceSessionsByHostId: byHost
  } as unknown as PersistedState
}

describe('findCrossHostPaneTabIds', () => {
  it('flags a tab id owned by the local partition and a host partition', () => {
    const state = stateWith(sessionWithTabs('tab-shared', 'tab-local'), {
      'ssh:box-a': sessionWithTabs('tab-shared', 'tab-remote')
    })
    expect([...findCrossHostPaneTabIds(state)]).toEqual(['tab-shared'])
  })

  it('flags a tab id owned by two host partitions', () => {
    const state = stateWith(sessionWithTabs('tab-local'), {
      'ssh:box-a': sessionWithTabs('tab-dup'),
      'runtime:env-1': sessionWithTabs('tab-dup')
    })
    expect([...findCrossHostPaneTabIds(state)]).toEqual(['tab-dup'])
  })

  it('does not flag a tab id confined to a single partition', () => {
    const state = stateWith(sessionWithTabs('a', 'b'), {
      'ssh:box-a': sessionWithTabs('c')
    })
    expect(findCrossHostPaneTabIds(state).size).toBe(0)
  })

  it('tolerates a missing host-partition map', () => {
    const state = stateWith(sessionWithTabs('only'))
    expect(findCrossHostPaneTabIds(state).size).toBe(0)
  })
})

describe('withoutPaneTabIds', () => {
  it('drops the colliding tab ids from the remap', () => {
    const remap = new Map([
      ['keep', new Map([['a', 'A']])],
      ['drop', new Map([['b', 'B']])]
    ])
    const filtered = withoutPaneTabIds(remap, new Set(['drop']))
    expect([...filtered.keys()]).toEqual(['keep'])
  })

  it('returns the same map instance when there is nothing to drop', () => {
    const remap = new Map([['keep', new Map([['a', 'A']])]])
    expect(withoutPaneTabIds(remap, new Set())).toBe(remap)
  })
})
