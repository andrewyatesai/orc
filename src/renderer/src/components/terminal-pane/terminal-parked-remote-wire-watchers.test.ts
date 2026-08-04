/**
 * Remote-wire parked watchers (ssh-pane-parking.md §3.3): a parked `remote:`
 * pane's bytes bypass local main, so its watcher runs off the shared stream
 * source and the source's runtime-confirmed exit — never pty:data/pty:exit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const REMOTE_PTY_ID = 'remote:env-1@@terminal-1'

type StartedWatcher = {
  options: ParkedTerminalByteWatcherOptions
  dispose: ReturnType<typeof vi.fn>
}

const startedWatchers: StartedWatcher[] = []
const startParkedTerminalByteWatcher = vi.fn((options: ParkedTerminalByteWatcherOptions) => {
  const dispose = vi.fn()
  startedWatchers.push({ options, dispose })
  return dispose
})
vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: (options: ParkedTerminalByteWatcherOptions) =>
    startParkedTerminalByteWatcher(options)
}))

const subscribeToPtyExit = vi.fn((_ptyId: string, _callback: (code: number) => void) => vi.fn())
vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: (code: number) => void) =>
    subscribeToPtyExit(ptyId, callback)
}))

vi.mock('./pty-pre-handler-buffer', () => ({ discardPreHandlerPtyState: vi.fn() }))

type RemoteByteSourceOptions = {
  ptyId: string
  settings: unknown
  onExitConfirmed: () => void
}
type RemoteByteSourceInstance = {
  options: RemoteByteSourceOptions
  subscribeBytes: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}
const remoteByteSources: RemoteByteSourceInstance[] = []
const createParkedRemoteTerminalByteSource = vi.fn((options: RemoteByteSourceOptions) => {
  const instance: RemoteByteSourceInstance = {
    options,
    subscribeBytes: vi.fn(() => vi.fn()),
    dispose: vi.fn()
  }
  remoteByteSources.push(instance)
  return {
    subscribeBytes: instance.subscribeBytes,
    // Mirror the real resolution: owner from the id, else park-time active env, else null.
    runtimeEnvironmentId: options.ptyId.includes('@@') ? 'env-1' : null,
    dispose: instance.dispose
  }
})
vi.mock('./parked-remote-terminal-byte-source', () => ({
  createParkedRemoteTerminalByteSource: (options: RemoteByteSourceOptions) =>
    createParkedRemoteTerminalByteSource(options)
}))

const sendRuntimePtyInput = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args)
}))

const closeTerminalTab = vi.fn()
vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: (tabId: string, options?: unknown) => closeTerminalTab(tabId, options)
}))

type MockStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null }[]>
  terminalLayoutsByTabId: Record<string, unknown>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: Map<string, { status: { capabilities?: string[] } | null }>
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
}
let mockStoreState: MockStoreState
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import {
  captureParkedTerminalPaneCandidates,
  getParkedTerminalWatcherTabIds,
  pruneParkedTerminalWatchers,
  syncParkedTerminalTabWatchers
} from './terminal-parked-tab-watchers'

const ptyWrite = vi.fn()
const originalWindow = (globalThis as { window?: unknown }).window

function capturePanes(ptyId: string): void {
  captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
    { ptyId, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }
  ])
}

function syncParked(args?: {
  tabs?: { id: string; ptyId: string | null }[]
  parkedTabIds?: Iterable<string>
  remoteParkingEnabled?: boolean
}): void {
  syncParkedTerminalTabWatchers({
    worktreeId: WORKTREE_ID,
    tabs: args?.tabs ?? [{ id: TAB_ID, ptyId: PTY_ID }],
    parkedTabIds: new Set(args?.parkedTabIds ?? [TAB_ID]),
    ...(args?.remoteParkingEnabled !== undefined
      ? { remoteParkingEnabled: args.remoteParkingEnabled }
      : {})
  })
}

describe('parked remote-wire watchers', () => {
  beforeEach(() => {
    mockStoreState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      settings: null,
      runtimeStatusByEnvironmentId: new Map([
        ['env-1', { status: { capabilities: ['terminal.paired-parking.v1'] } }]
      ]),
      clearTabLaunchAgent: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      setRuntimePaneTitle: vi.fn(),
      setTabLayout: vi.fn(),
      updateTabTitle: vi.fn()
    }
    ;(globalThis as { window?: unknown }).window = { api: { pty: { write: ptyWrite } } }
  })

  afterEach(() => {
    pruneParkedTerminalWatchers(new Set())
    startedWatchers.length = 0
    remoteByteSources.length = 0
    vi.clearAllMocks()
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  it('starts with an injected byte source, runtime input, and the owner environment', () => {
    capturePanes(REMOTE_PTY_ID)
    syncParked({ tabs: [{ id: TAB_ID, ptyId: REMOTE_PTY_ID }], remoteParkingEnabled: true })

    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(1)
    expect(createParkedRemoteTerminalByteSource).toHaveBeenCalledTimes(1)
    expect(remoteByteSources[0].options.ptyId).toBe(REMOTE_PTY_ID)
    const options = startedWatchers[0].options
    expect(options).toMatchObject({
      ptyId: REMOTE_PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: 1,
      // Why non-null: forces byte-parser mode — remote side effects are renderer-parsed.
      runtimeEnvironmentId: 'env-1'
    })
    expect(options.subscribeBytes).toBe(remoteByteSources[0].subscribeBytes)
    // sendInput routes through the runtime RPC channel, never local pty.write.
    options.sendInput('\x1b[?2031;1$y')
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(null, REMOTE_PTY_ID, '\x1b[?2031;1$y')
    expect(ptyWrite).not.toHaveBeenCalled()
    // Remote ids never emit pty:exit; the byte source owns exit classification.
    expect(subscribeToPtyExit).not.toHaveBeenCalled()
  })

  it('closes the tab like a pty exit when the runtime confirms the remote exit', () => {
    capturePanes(REMOTE_PTY_ID)
    syncParked({ tabs: [{ id: TAB_ID, ptyId: REMOTE_PTY_ID }], remoteParkingEnabled: true })

    remoteByteSources[0].options.onExitConfirmed()

    expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 1)
    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(remoteByteSources[0].dispose).toHaveBeenCalledTimes(1)
    expect(closeTerminalTab).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ captureRecentlyClosed: false, hostCloseReason: 'pty-exit' })
    )
  })

  it('disposes the byte source when the tab unparks', () => {
    capturePanes(REMOTE_PTY_ID)
    syncParked({ tabs: [{ id: TAB_ID, ptyId: REMOTE_PTY_ID }], remoteParkingEnabled: true })
    syncParked({
      tabs: [{ id: TAB_ID, ptyId: REMOTE_PTY_ID }],
      parkedTabIds: [],
      remoteParkingEnabled: true
    })

    expect(startedWatchers[0].dispose).toHaveBeenCalledTimes(1)
    expect(remoteByteSources[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('leaves local ptys on the pty:data sidecar and pty:exit', () => {
    capturePanes(PTY_ID)
    syncParked()

    expect(startParkedTerminalByteWatcher).toHaveBeenCalledTimes(1)
    expect(createParkedRemoteTerminalByteSource).not.toHaveBeenCalled()
    expect(startedWatchers[0].options.subscribeBytes).toBeUndefined()
    expect(startedWatchers[0].options.runtimeEnvironmentId).toBeUndefined()
    expect(subscribeToPtyExit).toHaveBeenCalledTimes(1)
  })

  it('starts nothing when the scoped remote-parking switch is off', () => {
    capturePanes(REMOTE_PTY_ID)
    syncParked({ tabs: [{ id: TAB_ID, ptyId: null }], remoteParkingEnabled: false })

    expect(startParkedTerminalByteWatcher).not.toHaveBeenCalled()
    expect(createParkedRemoteTerminalByteSource).not.toHaveBeenCalled()
    // Why: the tab still registers as parked so debug introspection sees it.
    expect(getParkedTerminalWatcherTabIds()).toEqual([TAB_ID])
  })

  it('starts nothing for a paired host that never advertised bounded restore', () => {
    mockStoreState.runtimeStatusByEnvironmentId = new Map()
    capturePanes(REMOTE_PTY_ID)
    syncParked({ tabs: [{ id: TAB_ID, ptyId: null }], remoteParkingEnabled: true })

    expect(startParkedTerminalByteWatcher).not.toHaveBeenCalled()
    expect(createParkedRemoteTerminalByteSource).not.toHaveBeenCalled()
  })
})
