import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { mobileTasksRouteTarget } from './mobile-tasks-route'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'

const homeSource = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8')

function navigationHarness(initialState: HostStackNavigationState) {
  const stateListeners = new Set<() => void>()
  let state = initialState
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    setState(nextState: HostStackNavigationState) {
      state = nextState
      for (const listener of stateListeners) {
        listener()
      }
    }
  }
}

function mountedHostState(hostId: string): HostStackNavigationState {
  return {
    index: 1,
    routes: [
      { name: 'index' },
      {
        name: 'h',
        state: {
          key: '/h',
          index: 0,
          routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId } }]
        }
      }
    ]
  }
}

describe('mobile tasks route', () => {
  it('carries the selected provider as taskSource', () => {
    expect(mobileTasksRouteTarget('host/one', 'linear')).toEqual({
      name: '[hostId]/tasks',
      params: { hostId: 'host/one', taskSource: 'linear' }
    })
  })

  it('omits taskSource instead of sending an empty param when no provider is chosen', () => {
    expect(mobileTasksRouteTarget('host-1').params).toEqual({ hostId: 'host-1' })
  })

  it('mounts the host before replacing it with the Tasks route', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()
    const target = mobileTasksRouteTarget('host/one', 'github')

    navigateToHostStackRoute(harness.navigation, { push }, 'host/one', target)

    expect(push).toHaveBeenCalledWith(hostStackHostRoute('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(mountedHostState('host/one'))

    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: target
    })
  })

  it('routes the home Tasks card through the cold-navigator-safe transition', () => {
    const start = homeSource.indexOf('const openTasks = useCallback(')
    const end = homeSource.indexOf('const renderTaskHomeCard', start)

    // Assert the markers first: a renamed handler would otherwise slice garbage and
    // report a missing call instead of the real cause.
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const openTasksHandler = homeSource.slice(start, end)
    expect(openTasksHandler).toContain('openMobileTasks(primaryConnectedHost.id')
    expect(openTasksHandler).not.toContain('router.push(')
  })
})
