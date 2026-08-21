import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  pasteDraftWhenAgentReady,
  POST_PASTE_SUBMIT_DELAY_MS,
  sendAgentDraftPasteContent,
  sendBracketedPasteToRunningAgent,
  submitPromptToAgentPty
} from './agent-paste-draft'

const testState = vi.hoisted(() => ({
  appState: {
    settings: {},
    ptyIdsByTabId: { 'tab-1': ['pty-1'] } as Record<string, string[]>,
    runtimePaneTitlesByTabId: {},
    tabsByWorktree: {} as Record<string, { id: string; title?: string }[]>,
    repos: [] as { id: string; connectionId: string | null; executionHostId?: string | null }[],
    worktreesByRepo: {} as Record<string, { id: string; repoId: string }[]>
  },
  storeSubscribers: new Set<(state: { ptyIdsByTabId: Record<string, string[]> }) => void>(),
  ptyObserver: null as ((data: string) => void) | null,
  unsubscribe: vi.fn(),
  subscribeToPtyData: vi.fn(),
  replayPreHandlerPtyData: vi.fn(),
  isRemoteRuntimePtyId: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  subscribeToRuntimeTerminalData: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: (
      subscriber: (state: { ptyIdsByTabId: Record<string, string[]> }) => void
    ): (() => void) => {
      testState.storeSubscribers.add(subscriber)
      return () => testState.storeSubscribers.delete(subscriber)
    }
  }
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: testState.subscribeToPtyData
}))

vi.mock('@/components/terminal-pane/pty-pre-handler-buffer', () => ({
  replayPreHandlerPtyData: testState.replayPreHandlerPtyData
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: testState.isRemoteRuntimePtyId,
  sendRuntimePtyInputVerified: testState.sendRuntimePtyInputVerified,
  inspectRuntimeTerminalProcess: testState.inspectRuntimeTerminalProcess
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  subscribeToRuntimeTerminalData: testState.subscribeToRuntimeTerminalData
}))

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT_RENDER = '\x1b[1m›\x1b[0m Ask Codex to do anything'
const ISSUE_URL = 'https://github.com/stablyai/orca/issues/123'
const PASTED_ISSUE_URL = `\x1b[200~${ISSUE_URL}\x1b[201~`

describe('pasteDraftWhenAgentReady running-agent drafts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.appState.settings = {}
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    testState.appState.runtimePaneTitlesByTabId = {}
    testState.appState.tabsByWorktree = {}
    testState.appState.repos = []
    testState.appState.worktreesByRepo = {}
    testState.storeSubscribers.clear()
    testState.ptyObserver = null
    testState.unsubscribe.mockReset()
    testState.subscribeToPtyData.mockReset()
    testState.subscribeToPtyData.mockImplementation(
      (_ptyId: string, observer: (data: string) => void) => {
        testState.ptyObserver = observer
        return testState.unsubscribe
      }
    )
    testState.replayPreHandlerPtyData.mockReset()
    testState.isRemoteRuntimePtyId.mockReset()
    testState.isRemoteRuntimePtyId.mockReturnValue(false)
    testState.sendRuntimePtyInputVerified.mockReset()
    testState.sendRuntimePtyInputVerified.mockResolvedValue(true)
    testState.inspectRuntimeTerminalProcess.mockReset()
    testState.inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'bash',
      hasChildProcesses: false
    })
    testState.subscribeToRuntimeTerminalData.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('submits to an already running agent without waiting for readiness signals', async () => {
    const promise = sendBracketedPasteToRunningAgent({
      ptyId: 'pty-1',
      content: ISSUE_URL
    })

    expect(testState.subscribeToPtyData).not.toHaveBeenCalled()
    expect(testState.subscribeToRuntimeTerminalData).not.toHaveBeenCalled()
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(49)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(2, {}, 'pty-1', '\r')
  })

  it('holds the PTY transaction across the paste and its submit Enter', async () => {
    const writes: string[] = []
    testState.sendRuntimePtyInputVerified.mockImplementation(
      async (_settings: unknown, _ptyId: string, data: string) => {
        writes.push(data)
        return true
      }
    )

    const submit = sendBracketedPasteToRunningAgent({ ptyId: 'pty-1', content: ISSUE_URL })
    await flushMicrotasks()
    // Competing chunked paste on the same PTY: it must not open a frame the Enter can land in.
    const competing = sendAgentDraftPasteContent(
      {},
      'pty-1',
      'y'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1)
    )
    await flushMicrotasks(10)
    expect(writes).toEqual([PASTED_ISSUE_URL])

    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)
    await expect(submit).resolves.toBe(true)
    await expect(competing).resolves.toBe(true)

    expect(writes.indexOf('\r')).toBe(1)
    expect(writes.at(2)).toBe('\x1b[200~')
    expect(writes.at(-1)).toBe('\x1b[201~')
  })

  it('submits to an exact PTY even when it is not the first PTY in the tab', async () => {
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-left', 'pty-right'] }
    testState.appState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1' }]
    }
    testState.appState.repos = [
      { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }
    ]
    testState.appState.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
    testState.appState.settings = { activeRuntimeEnvironmentId: 'owner-runtime' }

    const promise = submitPromptToAgentPty({
      tabId: 'tab-1',
      ptyId: 'pty-right',
      content: ISSUE_URL
    })

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(50)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      1,
      { activeRuntimeEnvironmentId: 'owner-runtime' },
      'pty-right',
      PASTED_ISSUE_URL
    )
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(
      2,
      { activeRuntimeEnvironmentId: 'owner-runtime' },
      'pty-right',
      '\r'
    )
  })

  it('streams large running-agent drafts as bounded bracketed chunks before submit', async () => {
    const content = 'x'.repeat(
      AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES + 7
    )
    const promise = sendBracketedPasteToRunningAgent({
      ptyId: 'pty-1',
      content
    })

    await flushMicrotasks(20)

    const calls = testState.sendRuntimePtyInputVerified.mock.calls
    expect(calls.at(0)).toEqual([{}, 'pty-1', '\x1b[200~'])
    expect(calls.at(-1)?.[2]).toBe('\x1b[201~')
    expect(
      calls
        .slice(1, -1)
        .map((call) => call[2])
        .join('')
    ).toBe(content)
    for (const call of calls.slice(1, -1)) {
      expect((call[2] as string).length).toBeLessThanOrEqual(AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES)
    }

    await vi.advanceTimersByTimeAsync(50)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenLastCalledWith({}, 'pty-1', '\r')
  })

  it('normalizes multiline running-agent drafts like terminal paste', async () => {
    const promise = sendBracketedPasteToRunningAgent({
      ptyId: 'pty-1',
      content: 'line one\r\nline two\nline three'
    })

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      '\x1b[200~line one\rline two\rline three\x1b[201~'
    )
    await vi.advanceTimersByTimeAsync(50)
    await expect(promise).resolves.toBe(true)
  })

  it('closes bracketed paste and does not submit when a chunked draft write is rejected', async () => {
    testState.sendRuntimePtyInputVerified
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const content = 'x'.repeat(
      AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES + 7
    )

    await expect(
      sendBracketedPasteToRunningAgent({
        ptyId: 'pty-1',
        content
      })
    ).resolves.toBe(false)

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledTimes(3)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(1, {}, 'pty-1', '[200~')
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenNthCalledWith(3, {}, 'pty-1', '[201~')
    expect(testState.sendRuntimePtyInputVerified.mock.calls.some((call) => call[2] === '\r')).toBe(
      false
    )
  })

  it('sanitizes escape bytes inside chunked agent draft paste content', () => {
    const chunks = chunkAgentDraftPasteContent('before\x1b[201~after😀', 6)

    expect(chunks.at(0)).toBe('\x1b[200~')
    expect(chunks.at(-1)).toBe('\x1b[201~')
    expect(chunks.slice(1, -1).join('')).toBe('before␛[201~after😀')
    expect(chunks.slice(1, -1).join('')).not.toContain('\x1b[201~')
  })

  it('normalizes agent draft line endings before a CRLF chunk boundary', () => {
    const chunks = chunkAgentDraftPasteContent('abc\r\ndef\nghi', 4)

    expect(chunks).toEqual(['\x1b[200~', 'abc\r', 'def\r', 'ghi', '\x1b[201~'])
    expect(chunks.join('')).not.toContain('\n')
  })

  it('chunks escape-heavy agent draft paste without per-character string sanitizer scans', () => {
    const content = Array.from({ length: 64 }, (_value, index) => `draft-${index}\x1b[201~`).join(
      ''
    )
    const includesSpy = vi.spyOn(String.prototype, 'includes')
    const replaceAllSpy = vi.spyOn(String.prototype, 'replaceAll')

    const chunks = chunkAgentDraftPasteContent(content, 12)
    const includesCallCount = includesSpy.mock.calls.length
    const replaceAllCallCount = replaceAllSpy.mock.calls.length
    includesSpy.mockRestore()
    replaceAllSpy.mockRestore()

    expect(chunks.at(0)).toBe('\x1b[200~')
    expect(chunks.at(-1)).toBe('\x1b[201~')
    expect(chunks.slice(1, -1).join('')).not.toContain('\x1b[201~')
    expect(chunks.slice(1, -1).join('')).toContain('␛[201~')
    expect(includesCallCount).toBe(0)
    expect(replaceAllCallCount).toBe(0)
  })

  it('keeps agent draft chunk arrays aligned with lazy chunk iteration', () => {
    const content = 'before\x1b[201~after😀'

    expect(chunkAgentDraftPasteContent(content, 6)).toEqual([
      ...iterateAgentDraftPasteContentChunks(content, 6)
    ])
  })

  it('iterates large agent draft chunks lazily', () => {
    const text = 'x'.repeat(128)
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const chunks = iterateAgentDraftPasteContentChunks(text, 8)

    expect(chunks.next()).toEqual({ done: false, value: '\x1b[200~' })
    expect(chunks.next()).toEqual({ done: false, value: 'x'.repeat(8) })

    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)
  })

  it('yields during large accepted-size preflight before writing agent draft chunks', async () => {
    const content = 'x'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 300 * 1024)
    const promise = sendAgentDraftPasteContent({}, 'pty-1', content)

    await flushMicrotasks(5)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    await vi.runOnlyPendingTimersAsync()
    await flushMicrotasks(10)

    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith({}, 'pty-1', '\x1b[200~')
    await expect(promise).resolves.toBe(true)
  })

  it('rejects oversized agent drafts before any PTY write', async () => {
    await expect(
      sendAgentDraftPasteContent({}, 'pty-1', 'x'.repeat(AGENT_DRAFT_PASTE_MAX_BYTES + 1))
    ).resolves.toBe(false)

    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })

  it('waits past the flat 8s budget for a cold Codex composer', async () => {
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'codex'
    })
    await flushMicrotasks()

    // Enable bracketed paste but keep Codex silent well past the old 8s deadline.
    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await vi.advanceTimersByTimeAsync(9000)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    // The composer finally renders inside Codex's 20s budget.
    testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      {},
      'pty-1',
      PASTED_ISSUE_URL
    )
  })

  it('keeps the 8s readiness budget for non-Codex agents', async () => {
    const onTimeout = vi.fn()
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: ISSUE_URL,
      agent: 'opencode',
      onTimeout
    })
    await flushMicrotasks()

    // opencode arms no quiet window, so only the hard budget governs delivery.
    testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
    await vi.advanceTimersByTimeAsync(7999)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    // Hard budget fires at 8s (not 20s), then the process-ownership fallback (bash) fails.
    await vi.advanceTimersByTimeAsync(2000)
    await flushMicrotasks(5)

    await expect(promise).resolves.toBe(false)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })
})

async function flushMicrotasks(iterations = 2): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}
