// Main-authority fact-consumer cases live in parked-terminal-fact-consumer.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import type * as ParkedTerminalCommandStatus from './parked-terminal-command-status'

const PTY_ID = 'pty-parked-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PANE_ID = 1
// Mirrors PARKED_NOTIFICATION_GRACE_MS / AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS.
const NOTIFICATION_GRACE_MS = 250

// Real agent-detection titles: braille spinner classifies as working,
// the "✳ " Claude prefix as idle, and both as Claude agents.
const WORKING_TITLE_OSC = '\x1b]0;⠋ Build feature\x07'
const IDLE_TITLE = '✳ Build feature'
const IDLE_TITLE_OSC = `\x1b]0;${IDLE_TITLE}\x07`

type MockStoreState = {
  settings: {
    theme?: 'system' | 'dark' | 'light'
    promptCacheTimerEnabled?: boolean
    experimentalTerminalAttention?: boolean
    terminalMainSideEffectAuthority?: boolean
    terminalHiddenDeliveryGate?: boolean
    notifications?: { enabled?: boolean; agentTaskComplete?: boolean }
  } | null
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  agentStatusByPaneKey: Record<string, { state: string; prompt: string; agentType?: string }>
}

const dispatchTerminalNotification = vi.fn()
let mockStoreState: MockStoreState

vi.mock('./use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

// Why: command-status semantics are covered in parked-terminal-command-status.test.ts;
// these tests only prove the watcher wires bytes/facts into the policy.
const commandStatusPolicy = {
  onCommandFinished: vi.fn(),
  onCommandCodeWorking: vi.fn(),
  onCommandCodeDone: vi.fn(),
  dispose: vi.fn()
}
// Partial mock: readInFlightCommandCodeTurn stays real so detector seeding reads the store.
vi.mock('./parked-terminal-command-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedTerminalCommandStatus>()),
  createParkedTerminalCommandStatusPolicy: vi.fn(() => commandStatusPolicy)
}))

vi.mock('@/lib/terminal-theme', () => ({
  getSystemPrefersDark: () => true
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

function createMockStoreState(): MockStoreState {
  return {
    // Why: terminalMainSideEffectAuthority false pins the legacy byte-parser
    // mode this suite was written for; the authority-on fact-consumer mode is
    // covered by the dedicated describe block below.
    settings: {
      theme: 'system',
      promptCacheTimerEnabled: true,
      experimentalTerminalAttention: false,
      terminalMainSideEffectAuthority: false,
      notifications: { enabled: true, agentTaskComplete: true }
    },
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabTitle: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn(),
    agentStatusByPaneKey: {}
  }
}

describe('startParkedTerminalByteWatcher', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null

  function emit(data: string): void {
    onData?.({ id: PTY_ID, data })
  }

  // The output processor defers title/bell side effects onto a 0ms drain timer.
  function flushSideEffects(): void {
    vi.advanceTimersByTime(0)
  }

  async function startWatcher(
    overrides: Partial<ParkedTerminalByteWatcherOptions> = {}
  ): Promise<{ dispose: () => void; sendInput: ReturnType<typeof vi.fn> }> {
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    const sendInput = vi.fn()
    const dispose = startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID,
      sendInput,
      ...overrides
    })
    return { dispose, sendInput }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    commandStatusPolicy.onCommandFinished.mockClear()
    commandStatusPolicy.onCommandCodeWorking.mockClear()
    commandStatusPolicy.onCommandCodeDone.mockClear()
    commandStatusPolicy.dispose.mockClear()
    onData = null
    mockStoreState = createMockStoreState()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        pty: {
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          ackData: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('forwards every OSC title in order to the pane and tab title store actions', async () => {
    const { dispose } = await startWatcher()

    emit(`${WORKING_TITLE_OSC}${IDLE_TITLE_OSC}`)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle.mock.calls).toEqual([
      [TAB_ID, PANE_ID, '⠋ Build feature'],
      [TAB_ID, PANE_ID, IDLE_TITLE]
    ])
    expect(mockStoreState.updateTabTitle.mock.calls).toEqual([
      [TAB_ID, '⠋ Build feature'],
      [TAB_ID, IDLE_TITLE]
    ])
    dispose()
  })

  it('drops the bare cursor-agent native title before it reaches the store', async () => {
    const { dispose } = await startWatcher()

    emit('\x1b]0;Cursor Agent\x07')
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).not.toHaveBeenCalled()
    expect(mockStoreState.updateTabTitle).not.toHaveBeenCalled()
    dispose()
  })

  it('does not drive the tab title when drivesTabTitle is false', async () => {
    const { dispose } = await startWatcher({ drivesTabTitle: false })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)
    expect(mockStoreState.updateTabTitle).not.toHaveBeenCalled()
    dispose()
  })

  it('marks unread on BEL and schedules the delayed terminal-bell OS notification', async () => {
    const { dispose } = await startWatcher()

    emit('build finished\x07')
    flushSideEffects()

    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)
    expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith(TAB_ID)
    expect(mockStoreState.markTerminalPaneUnread).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'terminal-bell',
      paneKey: PANE_KEY
    })
    dispose()
  })

  it('marks the exact pane unread when experimental terminal attention is enabled', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: true
    }
    const { dispose } = await startWatcher()

    emit('\x07')
    flushSideEffects()

    expect(mockStoreState.markTerminalPaneUnread).toHaveBeenCalledWith(PANE_KEY)
    dispose()
  })

  it('does not treat an OSC-terminator BEL as a bell, even split across chunks', async () => {
    const { dispose } = await startWatcher()

    emit('\x1b]0;par')
    emit('tial title\x07')
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    dispose()
  })

  it('fires the prompt-cache timer and agent-task-complete on working→idle', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    flushSideEffects()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
      PANE_KEY,
      expect.any(Number)
    )
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY
    })
    dispose()
  })

  it('suppresses the completion OS notification when only terminal attention is on', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: true,
      notifications: { enabled: true, agentTaskComplete: false }
    }
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY,
      suppressOsNotification: true
    })
    dispose()
  })

  it('skips completion dispatch when tracking is fully disabled, keeping the cache timer', async () => {
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false,
      notifications: { enabled: false }
    }
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
      PANE_KEY,
      expect.any(Number)
    )
    dispose()
  })

  it('lets a same-burst completion supersede the pending bell OS notification', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    flushSideEffects()
    emit(`${IDLE_TITLE_OSC}\x07`)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 8)

    // The bell still marks unread immediately; only the OS notification yields.
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({ source: 'agent-task-complete' })
    )
    dispose()
  })

  it('cancels the pending completion and clears the cache timer when working resumes', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    emit(WORKING_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)
    dispose()
  })

  it('answers a DECSET 2031 subscribe split across chunks via sendInput', async () => {
    const { dispose, sendInput } = await startWatcher()

    emit('\x1b[?20')
    expect(sendInput).not.toHaveBeenCalled()

    emit('31h')
    expect(sendInput).toHaveBeenCalledTimes(1)
    // theme=system + prefers-dark → dark reply per terminal-color-scheme-protocol.
    expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')

    emit('\x1b[?2031l')
    expect(sendInput).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('stops answering DECSET 2031 after dispose', async () => {
    const { dispose, sendInput } = await startWatcher()

    dispose()
    emit('\x1b[?2031h')

    expect(sendInput).not.toHaveBeenCalled()
  })

  it('observes GitHub PR links across chunk boundaries', async () => {
    const { dispose } = await startWatcher()

    emit('PR: https://github.com/orca-dev/orca/pull/42')
    expect(mockStoreState.observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()

    emit('1\r\ndone')
    expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledTimes(1)
    expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.objectContaining({
        url: 'https://github.com/orca-dev/orca/pull/421',
        number: 421,
        slug: { owner: 'orca-dev', repo: 'orca', host: 'github.com' }
      })
    )
    dispose()
  })

  it('scans OSC 133;D bytes into the parked command policy and disposes it with the watcher', async () => {
    const { dispose } = await startWatcher()

    emit('\x1b]133;D;0\x07')
    expect(commandStatusPolicy.onCommandFinished).toHaveBeenCalledWith(0)

    dispose()
    expect(commandStatusPolicy.dispose).toHaveBeenCalledTimes(1)
  })

  it('feeds Command Code output through the parked byte detector', async () => {
    const { dispose } = await startWatcher()

    emit('# Command Code v0.27.2')
    emit('⌘ Parsing...')

    expect(commandStatusPolicy.onCommandCodeWorking).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('feeds a Command Code return to the idle composer through as done', async () => {
    const { dispose } = await startWatcher()

    emit('# Command Code v0.27.2\r\n')
    emit('❯ Fix the spinner\r\n')
    emit('\r\n❯ Ask your question...\r\n')

    expect(commandStatusPolicy.onCommandCodeDone).toHaveBeenCalledWith('Fix the spinner')
    dispose()
  })

  it('arms the Command Code scrape from a turn already in flight at park time', async () => {
    // Why: the banner scrolled away long before the park, so only the live
    // status row can tell the fresh detector this is a Command Code TUI.
    mockStoreState.agentStatusByPaneKey = {
      [PANE_KEY]: { state: 'working', prompt: 'Fix the spinner', agentType: 'command-code' }
    }
    const { dispose } = await startWatcher()

    emit('\r\n❯ Ask your question...\r\n')

    expect(commandStatusPolicy.onCommandCodeDone).toHaveBeenCalledWith('Fix the spinner')
    dispose()
  })

  it('leaves the scrape unarmed when the parked pane has no in-flight Command Code turn', async () => {
    mockStoreState.agentStatusByPaneKey = {
      [PANE_KEY]: { state: 'done', prompt: 'Fix the spinner', agentType: 'command-code' }
    }
    const { dispose } = await startWatcher()

    emit('\r\n❯ Ask your question...\r\n')
    emit('⌘ Parsing...')

    expect(commandStatusPolicy.onCommandCodeDone).not.toHaveBeenCalled()
    expect(commandStatusPolicy.onCommandCodeWorking).not.toHaveBeenCalled()
    dispose()
  })

  it('fires completion when seeded with a working title and the agent goes idle while parked', async () => {
    // Why: the pane was working at park time; the watcher's fresh tracker
    // must be seeded or this working→idle transition can never fire.
    const { dispose } = await startWatcher({ initialTitle: '⠋ Build feature' })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
      source: 'agent-task-complete',
      terminalTitle: IDLE_TITLE,
      paneKey: PANE_KEY
    })
    dispose()
  })

  it('does not fire completion for an idle title without a seed or observed transition', async () => {
    const { dispose } = await startWatcher()

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    dispose()
  })

  it('clears the watcher-written runtime title slot on dispose', async () => {
    const { dispose } = await startWatcher()

    emit(IDLE_TITLE_OSC)
    flushSideEffects()
    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)

    dispose()
    expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID)
  })

  it('leaves the runtime title slot alone on dispose when it never wrote one', async () => {
    const { dispose } = await startWatcher()

    emit('plain output with no titles\r\n')
    flushSideEffects()

    dispose()
    expect(mockStoreState.clearRuntimePaneTitle).not.toHaveBeenCalled()
  })

  it('shutdown dispose cancels the armed completion timer and silences the final flush', async () => {
    const { dispose } = await startWatcher()

    emit(WORKING_TITLE_OSC)
    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    // Equivalent to shutdownWorktreeTerminals → disposeParkedTerminalWatchersForPtyIds.
    dispose()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    // The teardown flush that main emits after pty.kill must be a no-op.
    emit('final teardown flush\x07')
    flushSideEffects()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
    expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('dispose unregisters the sidecar and cancels the pending bell notification', async () => {
    const { dispose } = await startWatcher()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledTimes(1)

    dispose()
    vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()

    emit('\x07')
    flushSideEffects()
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledTimes(1)

    // Idempotent: a second dispose must not throw or clobber another watcher.
    dispose()
  })

  it('disposes the previous watcher when a new one starts for the same PTY', async () => {
    await startWatcher({ paneId: 1 })
    const second = await startWatcher({ paneId: 2 })

    emit(IDLE_TITLE_OSC)
    flushSideEffects()

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledTimes(1)
    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, 2, IDLE_TITLE)
    second.dispose()
  })

  it('consumes host facts without a raw terminal stream for paired PTYs', async () => {
    const remotePtyId = 'remote:env-1@@terminal-1'
    const { dispose } = await startWatcher({ ptyId: remotePtyId })
    const handler = await import('./terminal-side-effect-facts-handler')

    expect(onData).toBeNull()
    handler._dispatchTerminalSideEffectBatchForTest({
      ptyId: remotePtyId,
      seq: 10,
      facts: [
        {
          kind: 'title',
          normalizedTitle: '⠋ Remote build',
          rawTitle: '⠋ Remote build'
        }
      ]
    })

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(
      TAB_ID,
      PANE_ID,
      '⠋ Remote build'
    )
    dispose()
  })

  // ─── Injected remote byte source (ssh-pane-parking.md §3.3, phase 2) ────
  //
  // A parked remote: pane's bytes never transit local main, so the watcher
  // receives a shared stream source and a non-null runtimeEnvironmentId that
  // pins byte-parser mode regardless of the main-authority switch.
  describe('with an injected remote byte source', () => {
    const REMOTE_PTY_ID = 'remote:env-1@@terminal-1'

    type InjectedSource = {
      subscribeBytes: ((cb: (data: string) => void) => () => void) & ReturnType<typeof vi.fn>
      emit: (data: string) => void
      disposers: ReturnType<typeof vi.fn>[]
    }

    function createInjectedSource(): InjectedSource {
      const callbacks = new Set<(data: string) => void>()
      const disposers: ReturnType<typeof vi.fn>[] = []
      const subscribeBytes = vi.fn((cb: (data: string) => void): (() => void) => {
        callbacks.add(cb)
        const dispose = vi.fn((): void => {
          callbacks.delete(cb)
        })
        disposers.push(dispose)
        return dispose
      }) as InjectedSource['subscribeBytes']
      return {
        subscribeBytes,
        emit: (data) => {
          for (const cb of callbacks) {
            cb(data)
          }
        },
        disposers
      }
    }

    it('remote bytes drive bell/title/completion parity in byte-parser mode despite main authority on', async () => {
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalMainSideEffectAuthority: true
      }
      const setHiddenRendererPty = vi.fn()
      ;(
        window as unknown as { api: { pty: Record<string, unknown> } }
      ).api.pty.setHiddenRendererPty = setHiddenRendererPty
      const source = createInjectedSource()
      const { dispose } = await startWatcher({
        ptyId: REMOTE_PTY_ID,
        runtimeEnvironmentId: 'env-1',
        subscribeBytes: source.subscribeBytes
      })

      source.emit(`${WORKING_TITLE_OSC}`)
      source.emit(`ding\x07${IDLE_TITLE_OSC}`)
      flushSideEffects()

      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(
        TAB_ID,
        PANE_ID,
        '⠋ Build feature'
      )
      expect(mockStoreState.updateTabTitle).toHaveBeenCalledWith(TAB_ID, IDLE_TITLE)
      expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)
      expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith(TAB_ID)
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
        source: 'agent-task-complete',
        terminalTitle: IDLE_TITLE,
        paneKey: PANE_KEY
      })
      // The injected source replaces the pty:data sidecar entirely, and the
      // hidden-delivery claim is skipped (main never gates what it never delivers).
      expect(window.api.pty.onData).not.toHaveBeenCalled()
      expect(setHiddenRendererPty).not.toHaveBeenCalled()
      dispose()
    })

    it('answers a DECSET 2031 subscribe from the injected source via the runtime sendInput', async () => {
      const source = createInjectedSource()
      const { dispose, sendInput } = await startWatcher({
        ptyId: REMOTE_PTY_ID,
        runtimeEnvironmentId: 'env-1',
        subscribeBytes: source.subscribeBytes
      })
      // Parser + 2031 responder share the one injected stream source.
      expect(source.subscribeBytes).toHaveBeenCalledTimes(2)

      source.emit('\x1b[?2031h')
      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')
      dispose()
    })

    it('dispose releases every injected subscription', async () => {
      const source = createInjectedSource()
      const { dispose } = await startWatcher({
        ptyId: REMOTE_PTY_ID,
        runtimeEnvironmentId: 'env-1',
        subscribeBytes: source.subscribeBytes
      })

      dispose()

      expect(source.disposers.length).toBeGreaterThan(0)
      for (const disposer of source.disposers) {
        expect(disposer).toHaveBeenCalled()
      }
      source.emit('\x07')
      flushSideEffects()
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    })
  })
})
