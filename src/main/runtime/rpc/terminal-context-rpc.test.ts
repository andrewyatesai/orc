// Wire contract for the context verbs: parameter validation, the optional-flag
// omission that keeps runtime defaults in one place, and the honesty fields
// surviving the dispatcher.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_CONTEXT_METHODS } from './methods/terminal-context'
import type {
  TerminalAgentView,
  TerminalCommandBlockText,
  TerminalCommandBlocksResult,
  TerminalHistoryWindow
} from '../../../shared/terminal-context-protocol'
import type { TerminalAgentTranscript } from '../../../shared/agent-transcript-protocol'

const HISTORY: TerminalHistoryWindow = {
  schema: 1,
  available: true,
  rows: ['one', 'two'],
  firstHostRow: 40,
  previousHostRow: 38,
  nextHostRow: 42,
  oldestHostRow: 0,
  latestHostRow: 99,
  totalRows: 100,
  hasMoreAbove: true,
  hasMoreBelow: true,
  evicted: false,
  limited: false,
  cols: 80,
  alternateScreen: false,
  blindSpots: [
    {
      capability: 'graphics',
      reason: 'inline-images-not-exposed',
      detail: 'x'
    }
  ]
}

const BLOCKS: TerminalCommandBlocksResult = {
  schema: 1,
  available: true,
  blocks: [],
  totalObserved: 0,
  evictedCount: 0,
  oldestCursor: '0',
  latestCursor: '0',
  shellIntegrationSeen: false,
  blindSpots: []
}

const BLOCK_TEXT: TerminalCommandBlockText = {
  schema: 1,
  outcome: 'evicted',
  block: null,
  lines: [],
  firstCursor: null,
  nextCursor: null,
  running: false,
  truncated: true,
  limited: false,
  blindSpots: []
}

const AGENT_VIEW: TerminalAgentView = {
  schema: 1,
  handle: 't-1',
  status: 'running',
  screen: {
    available: true,
    rows: ['ready'],
    cols: 80,
    rowCount: 24,
    cursor: { row: 0, col: 0 },
    alternateScreen: false
  },
  agent: { isRunningAgent: true, status: 'idle' },
  lastBlock: null,
  history: {
    available: true,
    oldestHostRow: 0,
    latestHostRow: 10,
    scrollbackRows: 5,
    hasMoreAbove: true
  },
  latestCursor: '12',
  blindSpots: [{ capability: 'video', reason: 'requires-present-path', detail: 'x' }]
}

const AGENT_TRANSCRIPT: TerminalAgentTranscript = {
  schema: 1,
  handle: 't-1',
  available: false,
  unavailable: 'remote-host',
  detail: 'This pane runs over SSH connection conn-7.',
  agent: 'claude',
  sessionId: 'sess-1',
  host: { kind: 'ssh', connectionId: 'conn-7' },
  path: '/home/u/.claude/projects/p/sess-1.jsonl',
  turns: [],
  hasMoreBefore: false,
  previousOffset: null,
  limited: false,
  blindSpots: [{ capability: 'agent-screen-state', reason: 'transcript-lags-pty', detail: 'x' }]
}

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    readTerminalHistory: vi.fn().mockResolvedValue(HISTORY),
    listTerminalCommandBlocks: vi.fn().mockReturnValue(BLOCKS),
    readTerminalCommandBlockText: vi.fn().mockReturnValue(BLOCK_TEXT),
    readTerminalAgentView: vi.fn().mockResolvedValue(AGENT_VIEW),
    readTerminalAgentTranscript: vi.fn().mockResolvedValue(AGENT_TRANSCRIPT),
    ...overrides
  } as unknown as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function dispatch(runtime: OrcaRuntimeService, method: string, params?: unknown) {
  return new RpcDispatcher({
    runtime,
    methods: TERMINAL_CONTEXT_METHODS
  }).dispatch(makeRequest(method, params))
}

describe('terminal.history', () => {
  it('passes the window request through and returns the honesty fields intact', async () => {
    const runtime = stubRuntime()
    const response = await dispatch(runtime, 'terminal.history', {
      terminal: 't-1',
      from: 40,
      count: 25
    })
    expect(response.ok).toBe(true)
    expect((response as { result: { history: TerminalHistoryWindow } }).result.history).toEqual(
      HISTORY
    )
    expect(runtime.readTerminalHistory).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ from: 40, count: 25 })
    )
  })

  it('omits absent optionals so the runtime owns the defaults', async () => {
    const runtime = stubRuntime()
    await dispatch(runtime, 'terminal.history', { terminal: 't-1' })
    const [, opts] = vi.mocked(runtime.readTerminalHistory).mock.calls[0]!
    expect(opts).not.toHaveProperty('from')
    expect(opts).not.toHaveProperty('count')
  })

  it('rejects a negative row rather than silently clamping it', async () => {
    const response = await dispatch(stubRuntime(), 'terminal.history', {
      terminal: 't-1',
      from: -5
    })
    expect(response.ok).toBe(false)
  })

  it('rejects a missing terminal handle', async () => {
    const response = await dispatch(stubRuntime(), 'terminal.history', {})
    expect(response.ok).toBe(false)
  })
})

describe('terminal.blocks and terminal.blockText', () => {
  it('returns the block list with its transcript floor', async () => {
    const runtime = stubRuntime()
    const response = await dispatch(runtime, 'terminal.blocks', {
      terminal: 't-1',
      limit: 5
    })
    expect((response as { result: { blocks: TerminalCommandBlocksResult } }).result.blocks).toEqual(
      BLOCKS
    )
    expect(runtime.listTerminalCommandBlocks).toHaveBeenCalledWith('t-1', {
      limit: 5
    })
  })

  it('defaults blockText to the newest block by omitting the index', async () => {
    const runtime = stubRuntime()
    await dispatch(runtime, 'terminal.blockText', { terminal: 't-1' })
    expect(runtime.readTerminalCommandBlockText).toHaveBeenCalledWith('t-1', {})
  })

  it('keeps an evicted outcome distinguishable from empty output', async () => {
    const response = await dispatch(stubRuntime(), 'terminal.blockText', {
      terminal: 't-1',
      index: 3
    })
    const result = (response as { result: { blockText: TerminalCommandBlockText } }).result
    expect(result.blockText.outcome).toBe('evicted')
    expect(result.blockText.lines).toEqual([])
  })
})

describe('terminal.agentView', () => {
  it('returns the consolidated view with its declared blind spots', async () => {
    const runtime = stubRuntime()
    const response = await dispatch(runtime, 'terminal.agentView', {
      terminal: 't-1'
    })
    const result = (response as { result: { agentView: TerminalAgentView } }).result
    expect(result.agentView).toEqual(AGENT_VIEW)
    expect(result.agentView.blindSpots.map((spot) => spot.capability)).toContain('video')
    expect(runtime.readTerminalAgentView).toHaveBeenCalledWith('t-1')
  })

  it('surfaces a runtime failure as a failed response rather than a partial view', async () => {
    const runtime = stubRuntime({
      readTerminalAgentView: vi.fn().mockRejectedValue(new Error('terminal_not_found'))
    } as unknown as Partial<OrcaRuntimeService>)
    const response = await dispatch(runtime, 'terminal.agentView', {
      terminal: 'gone'
    })
    expect(response.ok).toBe(false)
  })
})

describe('terminal.agentTranscript', () => {
  it('carries a named refusal through the dispatcher instead of an empty result', async () => {
    const runtime = stubRuntime()
    const response = await dispatch(runtime, 'terminal.agentTranscript', { terminal: 't-1' })
    const result = (response as { result: { agentTranscript: TerminalAgentTranscript } }).result
    expect(result.agentTranscript).toEqual(AGENT_TRANSCRIPT)
    expect(result.agentTranscript.unavailable).toBe('remote-host')
    expect(runtime.readTerminalAgentTranscript).toHaveBeenCalledWith('t-1', {})
  })

  it('forwards the window and the backward-paging offset', async () => {
    const runtime = stubRuntime()
    await dispatch(runtime, 'terminal.agentTranscript', { terminal: 't-1', limit: 5, before: 900 })
    expect(runtime.readTerminalAgentTranscript).toHaveBeenCalledWith('t-1', {
      limit: 5,
      before: 900
    })
  })

  it('rejects a negative offset rather than silently clamping it', async () => {
    const response = await dispatch(stubRuntime(), 'terminal.agentTranscript', {
      terminal: 't-1',
      before: -1
    })
    expect(response.ok).toBe(false)
  })
})
