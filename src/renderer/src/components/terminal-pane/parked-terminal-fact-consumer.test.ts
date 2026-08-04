// The fact-consumer half of parked-terminal-byte-watcher.test.ts; split out so
// neither file exceeds the test max-lines cap. Same harness, same describe path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectFact } from '../../../../shared/terminal-side-effect-facts'
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

  // ─── Main side-effect authority (terminal-side-effect-authority.md) ────
  //
  // With the kill switch on, the watcher must not register byte parsers —
  // main is the single byte parser and the watcher's policy block consumes
  // pty:sideEffect facts instead. The byte sidecar stays ONLY for the 2031
  // reply (query authority never moves to main); PR links arrive as facts.
  describe('with main side-effect authority on', () => {
    function enableMainAuthority(): void {
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalMainSideEffectAuthority: true
      }
    }

    async function dispatchFacts(
      facts: TerminalSideEffectFact[],
      options: { seq?: number; replay?: boolean } = {}
    ): Promise<void> {
      const handler = await import('./terminal-side-effect-facts-handler')
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: PTY_ID,
        seq: options.seq ?? 0,
        ...(options.replay ? { replay: true } : {}),
        facts
      })
    }

    /** Feed chunks the way OrcaRuntimeService.onPtyData does: OSC 9999 strip,
     *  shared title tracker, one fact batch per chunk — the main half of the
     *  migration-safety parity check. */
    async function emitViaMainTrackerFacts(chunks: string[]): Promise<void> {
      const { createAgentStatusOscProcessor } = await import('../../../../shared/agent-status-osc')
      const { createTerminalTitleTracker } =
        await import('../../../../shared/terminal-output-side-effects')
      const handler = await import('./terminal-side-effect-facts-handler')
      const processStatusChunk = createAgentStatusOscProcessor()
      let pending: TerminalSideEffectFact[] = []
      const tracker = createTerminalTitleTracker({
        onTitle: (normalizedTitle, rawTitle) =>
          pending.push({ kind: 'title', normalizedTitle, rawTitle }),
        onAgentBecameWorking: () => pending.push({ kind: 'agent-working' }),
        onAgentBecameIdle: (title) => pending.push({ kind: 'agent-idle', title }),
        onAgentExited: () => pending.push({ kind: 'agent-exited' }),
        onBell: () => pending.push({ kind: 'bell' })
      })
      let seq = 0
      for (const chunk of chunks) {
        seq += chunk.length
        tracker.handleChunk(processStatusChunk(chunk).cleanData)
        if (pending.length > 0) {
          handler._dispatchTerminalSideEffectBatchForTest({ ptyId: PTY_ID, seq, facts: pending })
          pending = []
        }
      }
      tracker.dispose()
    }

    type RecordedCall = [string, ...unknown[]]

    /** Wrap the policy-visible store actions so byte mode and fact mode can be
     *  compared as one ordered outcome sequence. Timestamps are masked. */
    function recordPolicyOutcomes(): RecordedCall[] {
      const calls: RecordedCall[] = []
      mockStoreState.setRuntimePaneTitle.mockImplementation((...args: unknown[]) => {
        calls.push(['setRuntimePaneTitle', ...args])
      })
      mockStoreState.updateTabTitle.mockImplementation((...args: unknown[]) => {
        calls.push(['updateTabTitle', ...args])
      })
      mockStoreState.markWorktreeUnread.mockImplementation((...args: unknown[]) => {
        calls.push(['markWorktreeUnread', ...args])
      })
      mockStoreState.markTerminalTabUnread.mockImplementation((...args: unknown[]) => {
        calls.push(['markTerminalTabUnread', ...args])
      })
      mockStoreState.markTerminalPaneUnread.mockImplementation((...args: unknown[]) => {
        calls.push(['markTerminalPaneUnread', ...args])
      })
      mockStoreState.setCacheTimerStartedAt.mockImplementation((key: unknown, at: unknown) => {
        calls.push(['setCacheTimerStartedAt', key, typeof at === 'number' ? '<ts>' : at])
      })
      dispatchTerminalNotification.mockImplementation((...args: unknown[]) => {
        calls.push(['dispatchTerminalNotification', ...args])
      })
      return calls
    }

    it('does not consume bytes: a byte BEL produces no unread or notification', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      emit('build finished\x07')
      flushSideEffects()
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('routes command lifecycle facts into the parked command policy', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([
        { kind: 'command-finished', exitCode: 0 },
        { kind: 'command-code-working', prompt: 'Fix the spinner' },
        { kind: 'command-code-done', prompt: 'Fix the spinner' }
      ])

      expect(commandStatusPolicy.onCommandFinished).toHaveBeenCalledWith(0)
      expect(commandStatusPolicy.onCommandCodeWorking).toHaveBeenCalledWith('Fix the spinner')
      expect(commandStatusPolicy.onCommandCodeDone).toHaveBeenCalledWith('Fix the spinner')
      dispose()
    })

    it('ignores replayed command lifecycle facts (no-attention-replay rule)', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([{ kind: 'command-finished', exitCode: 0 }], { seq: 5, replay: true })

      expect(commandStatusPolicy.onCommandFinished).not.toHaveBeenCalled()
      dispose()
    })

    it('does not request a title snapshot for an ordinary parked watcher', async () => {
      enableMainAuthority()
      const getSideEffectSnapshot = vi.fn()
      ;(
        window as unknown as {
          api: { pty: { getSideEffectSnapshot: typeof getSideEffectSnapshot } }
        }
      ).api.pty.getSideEffectSnapshot = getSideEffectSnapshot

      const { dispose } = await startWatcher()

      expect(getSideEffectSnapshot).not.toHaveBeenCalled()
      dispose()
    })

    it('restores a cold-started watcher title without replaying attention facts', async () => {
      enableMainAuthority()
      const getSideEffectSnapshot = vi.fn().mockResolvedValue({
        ptyId: PTY_ID,
        seq: 42,
        replay: true,
        facts: [
          { kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE },
          { kind: 'bell' },
          { kind: 'agent-idle', title: IDLE_TITLE }
        ] satisfies TerminalSideEffectFact[]
      })
      ;(
        window as unknown as {
          api: { pty: { getSideEffectSnapshot: typeof getSideEffectSnapshot } }
        }
      ).api.pty.getSideEffectSnapshot = getSideEffectSnapshot

      const { dispose } = await startWatcher({ restoreTitleOnRegister: true })
      await Promise.resolve()

      expect(getSideEffectSnapshot).toHaveBeenCalledWith(PTY_ID)
      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)
      expect(mockStoreState.updateTabTitle).toHaveBeenCalledWith(TAB_ID, IDLE_TITLE)
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(mockStoreState.setCacheTimerStartedAt).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('applies bell facts with the byte-mode policy: unread now, OS notification delayed', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([{ kind: 'bell' }])

      expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)
      expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith(TAB_ID)
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()

      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
        source: 'terminal-bell',
        paneKey: PANE_KEY
      })
      dispose()
    })

    it('fires the cache timer and completion from working→idle facts', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([
        { kind: 'title', normalizedTitle: '⠋ Build feature', rawTitle: '⠋ Build feature' },
        { kind: 'agent-working' }
      ])
      expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)

      await dispatchFacts([
        { kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE },
        { kind: 'agent-idle', title: IDLE_TITLE }
      ])
      expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
        PANE_KEY,
        expect.any(Number)
      )

      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
      expect(dispatchTerminalNotification).toHaveBeenCalledWith(WORKTREE_ID, {
        source: 'agent-task-complete',
        terminalTitle: IDLE_TITLE,
        paneKey: PANE_KEY
      })
      dispose()
    })

    it('clears state without completion attention for stale-derived idle facts', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([
        { kind: 'title', normalizedTitle: '⠋ Build feature', rawTitle: '⠋ Build feature' },
        { kind: 'agent-working' }
      ])
      // Main's unthrottled 3s stale-title rewrite: titles/cache clear, but a
      // merely-paused agent must not earn a task-complete notification.
      await dispatchFacts([
        {
          kind: 'title',
          normalizedTitle: 'Build feature',
          rawTitle: 'Build feature',
          staleWorkingTitleClear: true
        },
        { kind: 'agent-idle', title: 'Build feature', staleWorkingTitleClear: true }
      ])

      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenLastCalledWith(
        TAB_ID,
        PANE_ID,
        'Build feature'
      )
      expect(mockStoreState.setCacheTimerStartedAt).toHaveBeenLastCalledWith(PANE_KEY, null)
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      dispose()
    })

    it('replay batches restore the title only — attention facts never replay', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts(
        [
          { kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE },
          { kind: 'bell' },
          { kind: 'agent-idle', title: IDLE_TITLE }
        ],
        { replay: true }
      )
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)

      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(mockStoreState.setCacheTimerStartedAt).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
      dispose()
    })

    it('answers DECSET 2031 from the main 2031-subscribe fact, never the byte scan', async () => {
      // Why: with the hidden-delivery gate on (default), parked PTY bytes are
      // dropped in main — the fact is the only 2031 signal, and the byte
      // sidecar must NOT exist (its registration would re-enable delivery).
      enableMainAuthority()
      const { dispose, sendInput } = await startWatcher()

      emit('\x1b[?2031h')
      expect(sendInput).not.toHaveBeenCalled()

      await dispatchFacts([{ kind: '2031-subscribe' }])
      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')

      // Why: pr-link facts arrive on the channel; byte-scanning here too
      // would observe every link twice.
      emit('PR: https://github.com/orca-dev/orca/pull/42\r\n')
      expect(mockStoreState.observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()
      dispose()
    })

    it('marks the PTY hidden for delivery on start and clears it on dispose', async () => {
      enableMainAuthority()
      const setHiddenRendererPty = vi.fn()
      ;(
        window as unknown as { api: { pty: Record<string, unknown> } }
      ).api.pty.setHiddenRendererPty = setHiddenRendererPty
      const { dispose } = await startWatcher()

      expect(setHiddenRendererPty).toHaveBeenCalledWith(PTY_ID, true)

      dispose()
      // Why: the unhide must land before reveal re-registers pane handlers —
      // the watcher registry disposes watchers before the remount effect runs.
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, false)
    })

    it('ssh watcher starts in fact-consumer mode and takes the hidden-delivery gate claim', async () => {
      // Why: ssh bytes transit local main, so main authority + gate apply to the
      // ssh: class exactly like local PTYs (ssh-pane-parking.md phase 1).
      enableMainAuthority()
      const sshPtyId = 'ssh:conn-1@@pty-1'
      const setHiddenRendererPty = vi.fn()
      ;(
        window as unknown as { api: { pty: Record<string, unknown> } }
      ).api.pty.setHiddenRendererPty = setHiddenRendererPty
      const { dispose } = await startWatcher({ ptyId: sshPtyId })

      expect(setHiddenRendererPty).toHaveBeenCalledWith(sshPtyId, true)

      // Fact-consumer mode: a byte BEL must not fire policy (facts own it).
      onData?.({ id: sshPtyId, data: 'ding\x07' })
      flushSideEffects()
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()

      const handler = await import('./terminal-side-effect-facts-handler')
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: sshPtyId,
        seq: 1,
        facts: [{ kind: 'bell' }]
      })
      expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith(WORKTREE_ID)

      dispose()
      // The unhide lands on dispose, before the reveal remount registers pane handlers.
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith(sshPtyId, false)
    })

    it('keeps the byte 2031 responder and no hidden bit when the gate kill switch is off', async () => {
      enableMainAuthority()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalHiddenDeliveryGate: false
      } as MockStoreState['settings']
      const setHiddenRendererPty = vi.fn()
      ;(
        window as unknown as { api: { pty: Record<string, unknown> } }
      ).api.pty.setHiddenRendererPty = setHiddenRendererPty
      const { dispose, sendInput } = await startWatcher()

      // Gate off — bytes keep flowing, so the split-chunk byte scan answers.
      emit('\x1b[?20')
      expect(sendInput).not.toHaveBeenCalled()
      emit('31h')
      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith('\x1b[?997;1n')

      // Why: a 2031-subscribe fact must not double-fire the reply in byte
      // mode — exactly one responder owns the answer at any time.
      await dispatchFacts([{ kind: '2031-subscribe' }])
      expect(sendInput).toHaveBeenCalledTimes(1)

      expect(setHiddenRendererPty).not.toHaveBeenCalled()
      dispose()
    })

    it('observes PR links from pr-link facts with worktree attribution', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      const link = {
        url: 'https://github.com/orca-dev/orca/pull/421',
        slug: { owner: 'orca-dev', repo: 'orca' },
        number: 421
      }
      await dispatchFacts([{ kind: 'pr-link', link }])

      expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledTimes(1)
      expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
        WORKTREE_ID,
        link
      )
      dispose()
    })

    it('dispose unregisters the fact consumer and clears a written title slot', async () => {
      enableMainAuthority()
      const { dispose } = await startWatcher()

      await dispatchFacts([{ kind: 'title', normalizedTitle: IDLE_TITLE, rawTitle: IDLE_TITLE }])
      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID, IDLE_TITLE)

      dispose()
      expect(mockStoreState.clearRuntimePaneTitle).toHaveBeenCalledWith(TAB_ID, PANE_ID)

      await dispatchFacts([{ kind: 'bell' }])
      vi.advanceTimersByTime(NOTIFICATION_GRACE_MS * 4)
      expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
      expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    })

    // The key migration-safety check: the same bytes produce the identical
    // ordered store outcome whether the watcher parses them directly (kill
    // switch off) or consumes main-derived facts over the channel.
    it('produces identical store outcomes via the channel as the byte parser did', async () => {
      const fixtureChunks = [WORKING_TITLE_OSC, 'agent response body\r\n', `${IDLE_TITLE_OSC}\x07`]

      // Pass 1: legacy byte-parser mode.
      const byteModeCalls = recordPolicyOutcomes()
      {
        const { dispose } = await startWatcher()
        for (const chunk of fixtureChunks) {
          emit(chunk)
          flushSideEffects()
        }
        vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
        dispose()
      }

      // Pass 2: fresh modules/store, authority on, facts derived by the
      // shared main tracker from the same bytes.
      vi.resetModules()
      mockStoreState = createMockStoreState()
      dispatchTerminalNotification.mockReset()
      const factModeCalls = recordPolicyOutcomes()
      {
        enableMainAuthority()
        const { dispose } = await startWatcher()
        await emitViaMainTrackerFacts(fixtureChunks)
        vi.advanceTimersByTime(NOTIFICATION_GRACE_MS)
        dispose()
      }

      expect(byteModeCalls.length).toBeGreaterThan(0)
      expect(factModeCalls).toEqual(byteModeCalls)
    })
  })
})
