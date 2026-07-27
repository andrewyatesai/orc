import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

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

type ExitSubscription = {
  ptyId: string
  callback: (code: number, context: { hadPrimary: boolean }) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const exitSubscriptions: ExitSubscription[] = []
const subscribeToPtyExit = vi.fn(
  (ptyId: string, callback: (code: number, context: { hadPrimary: boolean }) => void) => {
    const unsubscribe = vi.fn()
    exitSubscriptions.push({ ptyId, callback, unsubscribe })
    return unsubscribe
  }
)

vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: (code: number) => void) =>
    subscribeToPtyExit(ptyId, callback)
}))

const consumePreHandlerPtyState = vi.fn()
vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: (ptyId: string) => consumePreHandlerPtyState(ptyId)
}))

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
    runtimeEnvironmentId: options.ptyId.includes('@@')
      ? 'env-1'
      : ((options.settings as { activeRuntimeEnvironmentId?: string | null } | null | undefined)
          ?.activeRuntimeEnvironmentId ?? null),
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

type CloseTerminalTabOptions = {
  captureRecentlyClosed?: boolean
  hostCloseReason?: string
  lifecyclePtyId?: string
  onClosed?: () => void
  onCancel?: () => void
}
const closeTerminalTab = vi.fn()
vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: (tabId: string, options?: CloseTerminalTabOptions) =>
    closeTerminalTab(tabId, options)
}))

type MockStoreState = {
  tabsByWorktree: Record<
    string,
    { id: string; launchAgent?: 'claude' | 'codex'; ptyId: string | null }[]
  >
  terminalLayoutsByTabId: Record<
    string,
    {
      root: unknown
      activeLeafId: string | null
      expandedLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  clearTabLaunchAgent: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import {
  captureParkedTerminalPaneCandidates,
  pruneParkedTerminalWatchers,
  shouldDeferParkedPtyExitTabClose,
  syncParkedTerminalTabWatchers
} from './terminal-parked-tab-watchers'
import { _resetSshParkedPaneRevealRestoreForTest } from './ssh-parked-reveal-restore'

const ptyWrite = vi.fn()
const originalWindow = (globalThis as { window?: unknown }).window

function capturePanes(
  panes: { ptyId: string | null; paneId: number; leafId: string; drivesTabTitle: boolean }[],
  args?: { tabId?: string; worktreeId?: string }
): void {
  captureParkedTerminalPaneCandidates(args?.tabId ?? TAB_ID, args?.worktreeId ?? WORKTREE_ID, panes)
}

function syncParked(args?: {
  worktreeId?: string
  tabs?: { id: string; ptyId: string | null }[]
  parkedTabIds?: Iterable<string>
  restoreTitleOnStartTabIds?: Iterable<string>
  remoteParkingEnabled?: boolean
}): void {
  syncParkedTerminalTabWatchers({
    worktreeId: args?.worktreeId ?? WORKTREE_ID,
    tabs: args?.tabs ?? [{ id: TAB_ID, ptyId: PTY_ID }],
    parkedTabIds: new Set(args?.parkedTabIds ?? [TAB_ID]),
    ...(args?.restoreTitleOnStartTabIds
      ? { restoreTitleOnStartTabIds: new Set(args.restoreTitleOnStartTabIds) }
      : {}),
    ...(args?.remoteParkingEnabled !== undefined
      ? { remoteParkingEnabled: args.remoteParkingEnabled }
      : {})
  })
}

describe('terminal-parked-tab-watchers', () => {
  beforeEach(() => {
    mockStoreState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      clearTabLaunchAgent: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      setTabLayout: vi.fn(),
      updateTabTitle: vi.fn()
    }
    ;(globalThis as { window?: unknown }).window = { api: { pty: { write: ptyWrite } } }
  })

  afterEach(() => {
    // Module-level registries persist across tests; clear them through the
    // public prune path so each test starts from an empty parked state.
    pruneParkedTerminalWatchers(new Set())
    _resetSshParkedPaneRevealRestoreForTest()
    startedWatchers.length = 0
    exitSubscriptions.length = 0
    remoteByteSources.length = 0
    vi.clearAllMocks()
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  describe('shouldDeferParkedPtyExitTabClose', () => {
    const closeTab = vi.fn()

    // Mirrors both hosts' onPtyExit wiring: the guard runs before closeTab.
    function hostOnPtyExit(tabId: string, ptyId: string): void {
      if (shouldDeferParkedPtyExitTabClose(tabId, ptyId)) {
        return
      }
      closeTab(tabId)
    }

    it('defers tab close on PTY exit in a parked multi-leaf tab and clears the dead slot', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()

      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(closeTab).not.toHaveBeenCalled()
      // The dead leaf's runtime-title slot cannot pin worktree status.
      expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 1)
    })

    it('collapses the exited leaf out of the stored layout when deferring', () => {
      // Why (regression, ghost/resurrected pane): a deferred parked exit that
      // leaves the leaf and its binding in the stored layout reattaches on
      // reveal — the daemon re-creates the exited session id as a fresh shell.
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: SECOND_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      hostOnPtyExit(TAB_ID, SECOND_PTY_ID)

      expect(closeTab).not.toHaveBeenCalled()
      expect(mockStoreState.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      })
    })

    it('retires launch/title hints when the launch-owning parked leaf exits', () => {
      mockStoreState.tabsByWorktree = {
        [WORKTREE_ID]: [{ id: TAB_ID, launchAgent: 'codex', ptyId: PTY_ID }]
      }
      mockStoreState.runtimePaneTitlesByTabId = {
        [TAB_ID]: { 1: 'Codex', 2: 'PowerShell' }
      }
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(mockStoreState.clearTabLaunchAgent).toHaveBeenCalledWith(TAB_ID)
      expect(mockStoreState.updateTabTitle).toHaveBeenCalledWith(TAB_ID, 'PowerShell')
    })

    it('keeps launch ownership when only a parked shell sibling exits', () => {
      mockStoreState.tabsByWorktree = {
        [WORKTREE_ID]: [{ id: TAB_ID, launchAgent: 'claude', ptyId: PTY_ID }]
      }
      mockStoreState.runtimePaneTitlesByTabId = { [TAB_ID]: { 1: 'Claude Code' } }
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: SECOND_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      hostOnPtyExit(TAB_ID, SECOND_PTY_ID)

      expect(mockStoreState.clearTabLaunchAgent).not.toHaveBeenCalled()
      expect(mockStoreState.updateTabTitle).toHaveBeenCalledWith(TAB_ID, 'Claude Code')
    })

    it('keeps exit→closeTab parity for a parked single-leaf tab', () => {
      capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
      syncParked()

      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(closeTab).toHaveBeenCalledWith(TAB_ID)
    })

    it('keeps exit→closeTab parity when the tab is not parked', () => {
      hostOnPtyExit(TAB_ID, PTY_ID)

      expect(closeTab).toHaveBeenCalledWith(TAB_ID)
    })

    it('collapses a dead leaf then closes when the last parked split leaf exits', () => {
      // Why: hosts' onPtyExit runs from a mounted TerminalPane, so an exit
      // that lands while parked reaches ONLY the watcher sidecar — it must run
      // the layout collapse itself or the leaf resurrects on reveal.
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
      }

      exitSubscriptions
        .find((entry) => entry.ptyId === SECOND_PTY_ID)
        ?.callback(0, { hadPrimary: false })

      expect(consumePreHandlerPtyState).toHaveBeenCalledWith(SECOND_PTY_ID)
      expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 2)
      expect(mockStoreState.setTabLayout).toHaveBeenCalledWith(TAB_ID, {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      })

      exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })
      const options = closeTerminalTab.mock.calls[0]?.[1] as CloseTerminalTabOptions
      options.onClosed?.()
      expect(consumePreHandlerPtyState).toHaveBeenCalledWith(PTY_ID)
    })

    it('collapses a dead split leaf even when a stale primary handler observed the exit (#9625)', () => {
      // Why (regression): a genuinely parked tab's PaneManager is destroyed, so
      // hadPrimary must not short-circuit before the surviving-sibling collapse,
      // or the dead leaf resurrects on reveal. discardPreHandlerPtyState runs
      // only in the size>1 collapse branch — the pre-fix order (hadPrimary first)
      // retired the sidecar without it.
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()

      exitSubscriptions
        .find((entry) => entry.ptyId === SECOND_PTY_ID)
        ?.callback(0, { hadPrimary: true })

      expect(consumePreHandlerPtyState).toHaveBeenCalledWith(SECOND_PTY_ID)
      expect(startedWatchers[1].dispose).toHaveBeenCalledTimes(1)
    })

    it('does not touch the layout when the last parked watcher exits (tab-level close owns it)', () => {
      capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
      syncParked()
      mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }

      exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })

      expect(mockStoreState.setTabLayout).not.toHaveBeenCalled()
    })

    it('closes the tab when the last surviving leaf of a parked split exits', () => {
      capturePanes([
        { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
        { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
      ])
      syncParked()

      // First leaf dies: deferred, then its exit sidecar drops the watcher.
      hostOnPtyExit(TAB_ID, PTY_ID)
      exitSubscriptions.find((entry) => entry.ptyId === PTY_ID)?.callback(0, { hadPrimary: false })
      expect(closeTab).not.toHaveBeenCalled()

      hostOnPtyExit(TAB_ID, SECOND_PTY_ID)
      expect(closeTab).toHaveBeenCalledWith(TAB_ID)
    })
  })
})
