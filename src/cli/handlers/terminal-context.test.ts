import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { COMMAND_SPECS } from '../specs'
import { validateCommandAndFlags } from '../args'
import { TERMINAL_CONTEXT_HANDLERS } from './terminal-context'

function client(call: ReturnType<typeof vi.fn>): RuntimeClient {
  return { call } as unknown as RuntimeClient
}

function invoke(key: string, argv: string[], result: unknown) {
  const call = vi.fn().mockResolvedValue({ result })
  const parsed = parseArgs(argv)
  return {
    call,
    run: () =>
      TERMINAL_CONTEXT_HANDLERS[key]({
        flags: parsed.flags,
        client: client(call),
        cwd: '/tmp/worktree',
        json: true
      })
  }
}

const HISTORY = {
  history: {
    schema: 1,
    available: true,
    rows: ['a'],
    firstHostRow: 40,
    previousHostRow: 20,
    nextHostRow: 41,
    oldestHostRow: 0,
    latestHostRow: 50,
    totalRows: 51,
    hasMoreAbove: true,
    hasMoreBelow: true,
    evicted: false,
    limited: false,
    cols: 80,
    alternateScreen: false,
    blindSpots: []
  }
}

describe('terminal context CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends a history window request with the stable row and count', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { call, run } = invoke(
      'terminal history',
      ['terminal', 'history', '--terminal', 'term-1', '--from', '40', '--count', '25'],
      HISTORY
    )
    await run()
    expect(call).toHaveBeenCalledWith('terminal.history', {
      terminal: 'term-1',
      from: 40,
      count: 25
    })
  })

  it('accepts --from 0 (the oldest retained row) rather than dropping it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { call, run } = invoke(
      'terminal history',
      ['terminal', 'history', '--terminal', 'term-1', '--from', '0'],
      HISTORY
    )
    await run()
    expect(call).toHaveBeenCalledWith('terminal.history', expect.objectContaining({ from: 0 }))
  })

  it('omits --from entirely when it was not passed, so the newest window is served', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { call, run } = invoke('terminal history', ['terminal', 'history'], HISTORY)
    await run()
    expect(call.mock.calls[0]![1]).not.toHaveProperty('from')
  })

  it('rejects a non-numeric row instead of sending it', async () => {
    const { run } = invoke('terminal history', ['terminal', 'history', '--from', 'abc'], HISTORY)
    await expect(run()).rejects.toThrow(/--from/)
  })

  it('sends the block list request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { call, run } = invoke(
      'terminal blocks',
      ['terminal', 'blocks', '--terminal', 'term-1', '--limit', '5'],
      {
        blocks: {
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
      }
    )
    await run()
    expect(call).toHaveBeenCalledWith('terminal.blocks', {
      terminal: 'term-1',
      limit: 5
    })
  })

  it('maps --block onto the block index and omits it when absent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const blockText = {
      blockText: {
        schema: 1,
        outcome: 'text',
        block: null,
        lines: ['out'],
        firstCursor: '1',
        nextCursor: '2',
        running: false,
        truncated: false,
        limited: false,
        blindSpots: []
      }
    }
    const withIndex = invoke(
      'terminal block-text',
      ['terminal', 'block-text', '--terminal', 'term-1', '--block', '7'],
      blockText
    )
    await withIndex.run()
    expect(withIndex.call).toHaveBeenCalledWith(
      'terminal.blockText',
      expect.objectContaining({ index: 7 })
    )

    const withoutIndex = invoke('terminal block-text', ['terminal', 'block-text'], blockText)
    await withoutIndex.run()
    expect(withoutIndex.call.mock.calls[0]![1]).not.toHaveProperty('index')
  })

  it('sends a single agent-view request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { call, run } = invoke(
      'terminal agent-view',
      ['terminal', 'agent-view', '--terminal', 'term-1'],
      {
        agentView: {
          schema: 1,
          handle: 'term-1',
          status: 'running',
          screen: {
            available: true,
            rows: ['ready'],
            cols: 80,
            rowCount: 24,
            cursor: null,
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
          latestCursor: '3',
          blindSpots: []
        }
      }
    )
    await run()
    expect(call).toHaveBeenCalledWith('terminal.agentView', {
      terminal: 'term-1'
    })
  })

  it('sends search flags as booleans the runtime understands', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { call, run } = invoke(
      'terminal search',
      [
        'terminal',
        'search',
        '--terminal',
        'term-1',
        '--query',
        'needle',
        '--regex',
        '--case-sensitive',
        '--max-matches',
        '10'
      ],
      {
        searchSchema: 1,
        available: true,
        matches: [],
        total: 0,
        incomplete: false,
        hostCols: 80
      }
    )
    await run()
    expect(call).toHaveBeenCalledWith('terminal.search', {
      terminal: 'term-1',
      query: 'needle',
      caseSensitive: true,
      regex: true,
      maxMatches: 10
    })
  })

  it('parses --regex and --case-sensitive as flags, not as value consumers', () => {
    // Registered in BOOLEAN_FLAGS, so the following token stays a value of its
    // own flag rather than being swallowed as this one's argument.
    const parsed = parseArgs([
      'terminal',
      'search',
      '--regex',
      '--query',
      'needle',
      '--case-sensitive'
    ])
    expect(parsed.flags.get('regex')).toBe(true)
    expect(parsed.flags.get('case-sensitive')).toBe(true)
    expect(parsed.flags.get('query')).toBe('needle')
  })

  it('accepts every context flag against the published specs', () => {
    const cases: string[][] = [
      ['terminal', 'history', '--from', '4', '--count', '10', '--json'],
      ['terminal', 'search', '--query', 'x', '--regex', '--case-sensitive', '--max-matches', '3'],
      ['terminal', 'blocks', '--limit', '2', '--json'],
      ['terminal', 'block-text', '--block', '1', '--limit', '5', '--json'],
      ['terminal', 'agent-view', '--json']
    ]
    for (const argv of cases) {
      const parsed = parseArgs(
        argv,
        COMMAND_SPECS.map((spec) => spec.path)
      )
      expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
    }
  })
})
