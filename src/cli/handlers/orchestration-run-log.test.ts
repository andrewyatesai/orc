import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

// Why: isolate the handler's flag-to-param mapping and its text rendering; printResult
// only writes output, so the formatter is captured from the call instead of stdout.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

type RunLogResult = {
  runId: string
  entries: { at: number; message: string }[]
  dropped: number
  retained: boolean
  run: { id: string; status: string; coordinator_handle: string } | undefined
}

function renderLastResult(): string {
  const call = vi.mocked(printResult).mock.calls[0]
  if (!call) {
    throw new Error('printResult was not called')
  }
  const [response, , format] = call as unknown as [
    { result: RunLogResult },
    boolean,
    (r: RunLogResult) => string
  ]
  return format(response.result)
}

describe('orchestration run-log CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockClear()
  })

  const invoke = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration run-log']({
      flags,
      client: { call: callMock },
      json: false
    } as never)

  it('maps --run and --from onto the runLog RPC params', async () => {
    callMock.mockResolvedValue({
      result: { runId: 'run_1', entries: [], dropped: 0, retained: true, run: undefined }
    })

    await invoke(
      new Map<string, string | boolean>([
        ['run', 'run_1'],
        ['from', 'term_coord']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.runLog', {
      runId: 'run_1',
      from: 'term_coord'
    })
  })

  it('renders retained entries oldest-first with a dropped-count trailer', async () => {
    callMock.mockResolvedValue({
      result: {
        runId: 'run_1',
        entries: [
          { at: 1_000, message: 'Dispatched task task_a to term_w1' },
          { at: 2_000, message: 'Stuck: 1 tasks blocked' }
        ],
        dropped: 3,
        retained: true,
        run: undefined
      }
    })

    await invoke(new Map([['run', 'run_1']]))

    const formatted = renderLastResult()
    expect(formatted.indexOf('Dispatched task task_a')).toBeLessThan(
      formatted.indexOf('Stuck: 1 tasks blocked')
    )
    expect(formatted).toContain('3 earlier entries dropped')
  })

  it('says the tail is not retained instead of implying silence', async () => {
    callMock.mockResolvedValue({
      result: {
        runId: 'run_1',
        entries: [],
        dropped: 0,
        retained: false,
        run: { id: 'run_1', status: 'failed', coordinator_handle: 'term_coord' }
      }
    })

    await invoke(new Map([['run', 'run_1']]))

    const formatted = renderLastResult()
    expect(formatted).toContain('not retained')
    expect(formatted).toContain('failed')
  })

  it('reports an empty retained log as empty, not as missing', async () => {
    callMock.mockResolvedValue({
      result: { runId: 'run_1', entries: [], dropped: 0, retained: true, run: undefined }
    })

    await invoke(new Map([['run', 'run_1']]))

    expect(renderLastResult()).toContain('log is empty')
  })
})
