import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from './types'
import type { HostProfile } from './types'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

const connectMock = vi.fn()
const loadHostsMock = vi.fn()

vi.mock('./rpc-client', () => ({
  connect: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('./host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('./host-store', () => ({
  loadHosts: () => loadHostsMock()
}))
vi.mock('./connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: () => () => {}
}))

import { RpcClientProvider } from './client-context'
import { useAllHostClients } from './use-all-host-clients'

function makeFakeClient(state: ConnectionState): RpcClient {
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  } as unknown as RpcClient
}

function host(id: string, lastConnected: number): HostProfile {
  return {
    id,
    name: id,
    endpoint: `ws://${id}`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected
  }
}

function suppressDeprecationWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  connectMock.mockReset()
  loadHostsMock.mockReset()
})

describe('useAllHostClients auto-connect fanout', () => {
  it('opens only the bounded auto-connect subset, not every tracked host', async () => {
    const hosts = ['a', 'b', 'c', 'd', 'e'].map((id, i) => host(id, i))
    const hostIds = hosts.map((h) => h.id)
    const autoConnectHostIds = ['a', 'b', 'c']
    connectMock.mockImplementation(() => makeFakeClient('connected'))
    loadHostsMock.mockResolvedValue(hosts)

    let latest: ReturnType<typeof useAllHostClients> = []
    function Probe(): null {
      latest = useAllHostClients(hostIds, { autoConnectHostIds })
      return null
    }

    const restore = suppressDeprecationWarning()
    let renderer: ReactTestRenderer | null = null
    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      // Flush the async openEntry() chain (loadHosts -> openHostLogicalClient -> notify).
      await act(async () => {})
      await act(async () => {})
    } finally {
      restore()
    }

    const openedHostIds = connectMock.mock.calls.map((call) => (call[0] as HostProfile).id).sort()
    expect(openedHostIds).toEqual(['a', 'b', 'c'])
    // The excluded hosts never opened a socket.
    expect(openedHostIds).not.toContain('d')
    expect(openedHostIds).not.toContain('e')
    // The hook only surfaces clients for the bounded subset.
    expect(latest.map((entry) => entry.hostId).sort()).toEqual(['a', 'b', 'c'])

    act(() => {
      renderer?.unmount()
    })
  })

  it('falls back to acquiring every host when no subset is supplied', async () => {
    const hosts = ['a', 'b'].map((id, i) => host(id, i))
    const hostIds = hosts.map((h) => h.id)
    connectMock.mockImplementation(() => makeFakeClient('connected'))
    loadHostsMock.mockResolvedValue(hosts)

    function Probe(): null {
      useAllHostClients(hostIds)
      return null
    }

    const restore = suppressDeprecationWarning()
    let renderer: ReactTestRenderer | null = null
    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      await act(async () => {})
      await act(async () => {})
    } finally {
      restore()
    }

    const openedHostIds = connectMock.mock.calls.map((call) => (call[0] as HostProfile).id).sort()
    expect(openedHostIds).toEqual(['a', 'b'])

    act(() => {
      renderer?.unmount()
    })
  })
})

// A client whose recovery path can change without a transport-state change —
// the seam that lets a scheduled Relay recovery surface "Connecting via Relay…".
type PathAwareClient = RpcClient & {
  emitPendingPath: (path: MobileConnectionPath | null) => void
}

function makePathAwareClient(state: ConnectionState): PathAwareClient {
  let pendingPath: MobileConnectionPath | null = null
  const pathListeners = new Set<() => void>()
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    getActivePath: () => 'tailscale',
    getPendingPath: () => pendingPath,
    onConnectionPathChange: (listener: () => void) => {
      pathListeners.add(listener)
      return () => pathListeners.delete(listener)
    },
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn(),
    emitPendingPath: (next: MobileConnectionPath | null) => {
      pendingPath = next
      for (const listener of pathListeners) {
        listener()
      }
    }
  } as unknown as PathAwareClient
}

describe('useAllHostClients recovery-path presentation', () => {
  it('rerenders observers when Relay becomes pending without a transport-state change', async () => {
    const client = makePathAwareClient('reconnecting')
    connectMock.mockImplementation(() => client)
    loadHostsMock.mockResolvedValue([host('a', 0)])

    let latest: ReturnType<typeof useAllHostClients> = []
    function Probe(): null {
      latest = useAllHostClients(['a'])
      return null
    }

    const restore = suppressDeprecationWarning()
    let renderer: ReactTestRenderer | null = null
    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      await act(async () => {})
      await act(async () => {})
    } finally {
      restore()
    }

    expect(latest[0]?.pendingPath).toBeNull()

    // No state change — only the recovery path moves; observers must still rerender.
    act(() => {
      client.emitPendingPath('relay')
    })
    expect(latest[0]?.state).toBe('reconnecting')
    expect(latest[0]?.pendingPath).toBe('relay')

    act(() => {
      renderer?.unmount()
    })
  })
})
