// Wire contract for terminal.screen: parameter validation, the optional-flag
// omission that keeps the budgets defaulted in ONE place (the runtime), and the
// honesty fields surviving the dispatcher intact.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_CONTEXT_METHODS } from './methods/terminal-context'
import type { TerminalScreenResult } from '../../../shared/terminal-screen-protocol'

const SCREEN: TerminalScreenResult = {
  schema: 1,
  available: true,
  detail: 'compact',
  rows: [{ row: 0, runs: [{ col: 0, cols: 6, text: 'picked', attrs: ['inverse'] }] }],
  gridRows: 24,
  gridCols: 80,
  firstRow: 0,
  rowsTruncated: false,
  runsReturned: 1,
  maxRuns: 4000,
  trailingBlanksTrimmed: true,
  defaultFg: '#c0c0c0',
  defaultBg: '#000000',
  cursor: { row: 0, col: 6, visible: true, style: 'steady-bar' },
  modes: {
    alternateScreen: true,
    applicationCursor: true,
    bracketedPaste: true,
    mouseTracking: 'none',
    sgrMouse: false,
    sgrPixels: false,
    mouseEncoding: 'sgr',
    kittyKeyboardFlags: 0,
    reverseVideo: false
  },
  contentSeq: 7,
  blindSpots: [{ capability: 'styles', reason: 'styled-grid-is-visible-only', detail: 'x' }]
}

function dispatcherWith(overrides: Partial<OrcaRuntimeService>) {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: TERMINAL_CONTEXT_METHODS })
}

function request(params: Record<string, unknown>): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.screen', params }
}

describe('terminal.screen', () => {
  it('returns the frame with its style, cursor and mode facts intact', async () => {
    const readTerminalScreen = vi.fn().mockResolvedValue(SCREEN)
    const response = await dispatcherWith({ readTerminalScreen }).dispatch(
      request({ terminal: 'term_1' })
    )
    expect(response.ok).toBe(true)
    const { screen } = (response as { result: { screen: TerminalScreenResult } }).result
    expect(screen.rows[0].runs[0].attrs).toEqual(['inverse'])
    expect(screen.modes?.applicationCursor).toBe(true)
    expect(screen.blindSpots[0].reason).toBe('styled-grid-is-visible-only')
  })

  it('omits absent optionals so the budgets default in the runtime, not here', async () => {
    const readTerminalScreen = vi.fn().mockResolvedValue(SCREEN)
    await dispatcherWith({ readTerminalScreen }).dispatch(request({ terminal: 'term_1' }))
    const [, opts] = readTerminalScreen.mock.calls[0]
    expect(Object.keys(opts as object).sort()).toEqual(['signal'])
  })

  it('forwards an explicit detail level and row window', async () => {
    const readTerminalScreen = vi.fn().mockResolvedValue(SCREEN)
    await dispatcherWith({ readTerminalScreen }).dispatch(
      request({ terminal: 'term_1', detail: 'full', fromRow: 8, rowCount: 4, maxRuns: 900 })
    )
    expect(readTerminalScreen.mock.calls[0][1]).toMatchObject({
      detail: 'full',
      fromRow: 8,
      rowCount: 4,
      maxRuns: 900
    })
  })

  it('rejects a missing terminal handle', async () => {
    const response = await dispatcherWith({ readTerminalScreen: vi.fn() }).dispatch(request({}))
    expect(response.ok).toBe(false)
  })

  it('rejects an undefined detail level rather than silently degrading it', async () => {
    const readTerminalScreen = vi.fn()
    const response = await dispatcherWith({ readTerminalScreen }).dispatch(
      request({ terminal: 'term_1', detail: 'lossless' })
    )
    expect(response.ok).toBe(false)
    expect(readTerminalScreen).not.toHaveBeenCalled()
  })

  it('rejects a negative row offset', async () => {
    const readTerminalScreen = vi.fn()
    const response = await dispatcherWith({ readTerminalScreen }).dispatch(
      request({ terminal: 'term_1', fromRow: -1 })
    )
    expect(response.ok).toBe(false)
    expect(readTerminalScreen).not.toHaveBeenCalled()
  })
})
