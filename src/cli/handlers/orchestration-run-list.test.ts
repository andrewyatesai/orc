import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

// Why: isolate the handler's flag mapping and its text rendering; printResult only
// writes output, so the formatter is captured from the call instead of stdout.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

type RunListResult = {
  runs: {
    id: string
    spec: string
    status: string
    coordinator_handle: string
    created_at: string
    live: boolean
    tasks: {
      completed: number
      failed: number
      blocked: number
      dispatched: number
      readyOrPending: number
      total: number
    }
    pendingGates: number
  }[]
  count: number
  limit: number
  offset: number
  hasMore: boolean
}

function run(
  overrides: Partial<RunListResult['runs'][number]> = {}
): RunListResult['runs'][number] {
  return {
    id: 'run_1',
    spec: 'ship it',
    status: 'running',
    coordinator_handle: 'term_coord',
    created_at: '2026-07-30 12:00:00',
    live: true,
    tasks: {
      completed: 6,
      failed: 2,
      blocked: 1,
      dispatched: 2,
      readyOrPending: 3,
      total: 14
    },
    pendingGates: 0,
    ...overrides
  }
}

function renderLastResult(): string {
  const call = vi.mocked(printResult).mock.calls[0]
  if (!call) {
    throw new Error('printResult was not called')
  }
  const [response, , format] = call as unknown as [
    { result: RunListResult },
    boolean,
    (r: RunListResult) => string
  ]
  return format(response.result)
}

function resolveWith(result: Partial<RunListResult>): void {
  callMock.mockResolvedValue({
    result: { runs: [], count: 0, limit: 20, offset: 0, hasMore: false, ...result }
  })
}

describe('orchestration run-list CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockClear()
  })

  const invoke = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration run-list']({
      flags,
      client: { call: callMock },
      json: false
    } as never)

  it('maps --limit and --offset onto the runList RPC params', async () => {
    resolveWith({})

    await invoke(
      new Map<string, string | boolean>([
        ['limit', '5'],
        ['offset', '10']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.runList', { limit: 5, offset: 10 })
  })

  it('leaves paging to the runtime when no flags are passed', async () => {
    resolveWith({})
    await invoke(new Map())
    expect(callMock).toHaveBeenCalledWith('orchestration.runList', {
      limit: undefined,
      offset: undefined
    })
  })

  it('rejects a non-numeric --limit before calling the runtime', async () => {
    await expect(invoke(new Map([['limit', 'lots']]))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('prints split counters, never a fraction', async () => {
    resolveWith({ runs: [run()], count: 1 })
    await invoke(new Map())

    const formatted = renderLastResult()
    expect(formatted).toContain('6 done · 2 failed · 1 blocked · 2 dispatched · 3 queued')
    // A fraction here would report the two failures as progress (app-modes §8.3).
    expect(formatted).not.toMatch(/\d+\s*\/\s*\d+/)
  })

  it('shows created_at so the output reads as history', async () => {
    resolveWith({ runs: [run({ created_at: '2026-07-30 12:00:00' })], count: 1 })
    await invoke(new Map())
    expect(renderLastResult()).toContain('created=2026-07-30 12:00:00')
  })

  it('marks a durably-running row with no live loop', async () => {
    resolveWith({
      runs: [run({ id: 'run_live' }), run({ id: 'run_stranded', live: false })],
      count: 2
    })
    await invoke(new Map())

    const formatted = renderLastResult()
    expect(formatted).toContain('run_live [running, live]')
    expect(formatted).toContain('run_stranded [running, no live loop]')
  })

  it('omits the liveness marker for a finished run', async () => {
    resolveWith({ runs: [run({ status: 'completed', live: false })], count: 1 })
    await invoke(new Map())
    expect(renderLastResult()).toContain('run_1 [completed]')
  })

  it('names the pending gate count only when there is one', async () => {
    resolveWith({ runs: [run({ pendingGates: 1 })], count: 1 })
    await invoke(new Map())
    expect(renderLastResult()).toContain('1 gate pending')

    vi.mocked(printResult).mockClear()
    resolveWith({ runs: [run({ pendingGates: 0 })], count: 1 })
    await invoke(new Map())
    expect(renderLastResult()).not.toContain('gate pending')
  })

  it('points at the next page instead of silently truncating', async () => {
    resolveWith({ runs: [run()], count: 1, limit: 1, offset: 2, hasMore: true })
    await invoke(new Map())
    expect(renderLastResult()).toContain('--offset 3')
  })

  it('says there are no runs rather than printing an empty block', async () => {
    resolveWith({})
    await invoke(new Map())
    expect(renderLastResult()).toBe('No runs.')
  })
})
