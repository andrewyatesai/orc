// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { useAppStore } from '@/store'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-01T00:00:00.000Z'
}

const THROTTLE_MS = 30_000

const listSessionsMock = vi.fn<(args: unknown) => Promise<AiVaultListResult>>()

// Captures the hook's subscription to the main-process window-focus push.
let windowFocusCallback: (() => void) | null = null
const onWindowFocusedMock = vi.fn((callback: () => void) => {
  windowFocusCallback = callback
  return () => {
    windowFocusCallback = null
  }
})

async function fireWindowFocused(): Promise<void> {
  await act(async () => {
    windowFocusCallback?.()
  })
  await flushMicrotasks()
}

const initialAppState = useAppStore.getInitialState()

const roots: Root[] = []
let latest: ReturnType<typeof useAiVaultSessionRefresh> | null = null

function HookProbe(props: {
  scopePaths: readonly string[]
  executionHostScope?: 'local' | 'all' | `ssh:${string}`
}): null {
  latest = useAiVaultSessionRefresh(props.scopePaths, props.executionHostScope ?? 'local')
  return null
}

async function renderHook(
  scopePaths: readonly string[] = [],
  executionHostScope: 'local' | 'all' | `ssh:${string}` = 'local'
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { scopePaths, executionHostScope }))
  })
}

async function rerenderHook(
  scopePaths: readonly string[] = [],
  executionHostScope: 'local' | 'all' | `ssh:${string}` = 'local'
): Promise<void> {
  const root = roots.at(-1)
  if (!root) {
    throw new Error('renderHook must be called before rerenderHook')
  }
  await act(async () => {
    root.render(createElement(HookProbe, { scopePaths, executionHostScope }))
  })
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function dispatch(target: EventTarget, type: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new Event(type))
  })
  await flushMicrotasks()
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await flushMicrotasks()
}

function makeAgentEntry(sessionId: string, state = 'working'): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey: `tab-${sessionId}:leaf-${sessionId}`,
    stateHistory: [],
    providerSession: { key: 'session_id', id: sessionId }
  } as AgentStatusEntry
}

async function setAgentStatuses(entries: Record<string, AgentStatusEntry>): Promise<void> {
  await act(async () => {
    useAppStore.setState({ agentStatusByPaneKey: entries })
  })
  await flushMicrotasks()
}

function lastCallArgs(): unknown {
  return listSessionsMock.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  vi.useFakeTimers()
  listSessionsMock.mockReset().mockResolvedValue(EMPTY_RESULT)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    aiVault: { listSessions: listSessionsMock, onWindowFocused: onWindowFocusedMock }
  }
  resetAiVaultForcedRescanThrottleForTest()
  useAppStore.setState(initialAppState, true)
})

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  useAppStore.setState(initialAppState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useAiVaultSessionRefresh refocus behavior', () => {
  it('uses the shared scan cache on local panel entry', async () => {
    await renderHook()
    await flushMicrotasks()

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(listSessionsMock.mock.calls[0]?.[0]).toMatchObject({
      executionHostScope: 'local',
      force: false
    })
  })

  it('passes the requested execution host scope to the scanner', async () => {
    await renderHook(['/repo'], 'ssh:dev-box')
    await flushMicrotasks()

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(lastCallArgs()).toMatchObject({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/repo']
    })
  })

  it('does not apply stale results after the host scope changes mid-scan', async () => {
    let resolveLocal: ((result: AiVaultListResult) => void) | null = null
    let resolveSsh: ((result: AiVaultListResult) => void) | null = null
    listSessionsMock
      .mockImplementationOnce(
        () => new Promise<AiVaultListResult>((resolve) => (resolveLocal = resolve))
      )
      .mockImplementationOnce(
        () => new Promise<AiVaultListResult>((resolve) => (resolveSsh = resolve))
      )

    await renderHook([], 'local')
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await rerenderHook(['/remote/repo'], 'ssh:dev-box')
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveLocal?.({ ...EMPTY_RESULT, scannedAt: '2026-07-01T00:00:01.000Z' })
    })
    await flushMicrotasks()

    expect(latest?.scanResult).toBeNull()
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/remote/repo']
    })

    await act(async () => {
      resolveSsh?.({ ...EMPTY_RESULT, scannedAt: '2026-07-01T00:00:02.000Z' })
    })
    await flushMicrotasks()

    expect(latest?.scanResult?.scannedAt).toBe('2026-07-01T00:00:02.000Z')
  })

  it('refreshes from the shared cache on refocus', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await fireWindowFocused()

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({ force: false })
  })

  it('does not force transcript scans for refocus events', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await fireWindowFocused()
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({ force: false })
  })

  it('ignores focus/visibility events while the document is hidden', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await advance(THROTTLE_MS + 1)
    await dispatch(document, 'visibilitychange')
    await fireWindowFocused()
    await advance(THROTTLE_MS + 1)

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('stops listening after unmount', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    roots.splice(0).forEach((root) => act(() => root.unmount()))
    await fireWindowFocused()
    await dispatch(document, 'visibilitychange')

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('does not raise the loading flag for refocus refreshes', async () => {
    await renderHook()
    await flushMicrotasks()
    await advance(THROTTLE_MS + 1)

    let resolveScan: ((result: AiVaultListResult) => void) | null = null
    listSessionsMock.mockImplementationOnce(
      () => new Promise<AiVaultListResult>((resolve) => (resolveScan = resolve))
    )
    await fireWindowFocused()

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(latest?.loading).toBe(false)

    await act(async () => {
      resolveScan?.({ ...EMPTY_RESULT, scannedAt: '2026-07-01T00:00:01.000Z' })
    })
    await flushMicrotasks()
    expect(latest?.loading).toBe(false)
  })

  it('skips state updates when a refresh returns the applied snapshot', async () => {
    await renderHook()
    await flushMicrotasks()
    const firstResult = latest?.scanResult

    // Same scannedAt = the snapshot already on screen was replayed.
    listSessionsMock.mockResolvedValueOnce({ ...EMPTY_RESULT })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()
    expect(latest?.scanResult).toBe(firstResult)

    listSessionsMock.mockResolvedValueOnce({
      ...EMPTY_RESULT,
      scannedAt: '2026-07-01T00:00:02.000Z'
    })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()
    expect(latest?.scanResult).not.toBe(firstResult)
  })

  it('keeps the manual refresh button forcing a cache bypass', async () => {
    await renderHook()
    await flushMicrotasks()

    await act(async () => {
      await latest?.refresh({ force: true })
    })

    expect(lastCallArgs()).toMatchObject({ force: true })
  })

  it('keeps refocus cache-backed after a manual force refresh', async () => {
    await renderHook()
    await flushMicrotasks()

    await act(async () => {
      await latest?.refresh({ force: true })
    })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    // The button forced a fresh scan; an immediate refocus still just reads the
    // shared cache rather than forcing a second transcript scan.
    await fireWindowFocused()
    expect(listSessionsMock).toHaveBeenCalledTimes(3)
    expect(lastCallArgs()).toMatchObject({ force: false })
  })
})

describe('useAiVaultSessionRefresh in-app agent session behavior', () => {
  it('force re-scans when an agent session starts inside Orca', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1') })

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({ force: true })
  })

  it('defers an in-throttle session start to a trailing forced scan', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    // First new session forces immediately (panel entry no longer primes the
    // throttle), which then holds a second start inside the window as trailing.
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await setAgentStatuses({ 'pane-2': makeAgentEntry('sess-2') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await advance(THROTTLE_MS + 1)
    expect(listSessionsMock).toHaveBeenCalledTimes(3)
    expect(lastCallArgs()).toMatchObject({ force: true })
  })

  it('ignores agent activity on already-known sessions', async () => {
    await renderHook()
    await flushMicrotasks()
    await advance(THROTTLE_MS + 1)
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1', 'working') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    // Message/tool pings and state transitions on a known session must not
    // re-trigger — only a session id we haven't seen does.
    await advance(THROTTLE_MS + 1)
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1', 'done') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    // A closed pane re-opening the same session is not a new session either.
    await setAgentStatuses({})
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1', 'working') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await setAgentStatuses({ 'pane-2': makeAgentEntry('sess-2', 'working') })
    expect(listSessionsMock).toHaveBeenCalledTimes(3)
  })
})
