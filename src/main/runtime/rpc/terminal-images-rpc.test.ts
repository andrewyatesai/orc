// Wire contract for terminal.images: parameter validation, the optional-flag
// omission that keeps the byte budgets defaulted in ONE place (the runtime), and
// the honesty fields surviving the dispatcher intact.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_CONTEXT_METHODS } from './methods/terminal-context'
import type { TerminalInlineImagesResult } from '../../../shared/terminal-inline-images-protocol'

const IMAGES: TerminalInlineImagesResult = {
  schema: 1,
  available: true,
  images: [
    {
      row: 2,
      col: 0,
      cellRows: 3,
      cellCols: 6,
      coveredCells: 18,
      clipped: false,
      format: 'png',
      pixelWidth: null,
      pixelHeight: null,
      byteLength: 68,
      zIndex: 0,
      fingerprint: '0123456789abcdef',
      payloadState: 'not-requested',
      base64: null
    }
  ],
  totalPlacements: 1,
  gridRows: 24,
  gridCols: 80,
  unscannableHistoryRows: 512,
  bytesRequested: false,
  maxBytesPerImage: 262144,
  maxTotalBytes: 1048576,
  bytesReturned: 0,
  blindSpots: [{ capability: 'graphics', reason: 'images-dropped-on-scroll-off', detail: 'x' }]
}

function dispatcherWith(overrides: Partial<OrcaRuntimeService>) {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: TERMINAL_CONTEXT_METHODS })
}

function request(params: Record<string, unknown>): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.images', params }
}

describe('terminal.images', () => {
  it('returns the result with its honesty fields intact', async () => {
    const readTerminalInlineImages = vi.fn().mockResolvedValue(IMAGES)
    const response = await dispatcherWith({ readTerminalInlineImages }).dispatch(
      request({ terminal: 'term_1' })
    )
    expect(response.ok).toBe(true)
    const { images } = (response as { result: { images: TerminalInlineImagesResult } }).result
    expect(images.unscannableHistoryRows).toBe(512)
    expect(images.blindSpots[0].reason).toBe('images-dropped-on-scroll-off')
  })

  it('omits absent optionals so the budgets default in the runtime, not here', async () => {
    const readTerminalInlineImages = vi.fn().mockResolvedValue(IMAGES)
    await dispatcherWith({ readTerminalInlineImages }).dispatch(request({ terminal: 'term_1' }))
    const [, opts] = readTerminalInlineImages.mock.calls[0]
    expect(Object.keys(opts as object).sort()).toEqual(['signal'])
  })

  it('forwards an explicit byte request and its budgets', async () => {
    const readTerminalInlineImages = vi.fn().mockResolvedValue(IMAGES)
    await dispatcherWith({ readTerminalInlineImages }).dispatch(
      request({
        terminal: 'term_1',
        includeBytes: true,
        maxBytesPerImage: 4096,
        maxTotalBytes: 8192
      })
    )
    expect(readTerminalInlineImages.mock.calls[0][1]).toMatchObject({
      includeBytes: true,
      maxBytesPerImage: 4096,
      maxTotalBytes: 8192
    })
  })

  it('rejects a missing terminal handle', async () => {
    const response = await dispatcherWith({
      readTerminalInlineImages: vi.fn()
    }).dispatch(request({}))
    expect(response.ok).toBe(false)
  })

  it('rejects a non-boolean includeBytes rather than coercing it', async () => {
    const readTerminalInlineImages = vi.fn()
    const response = await dispatcherWith({ readTerminalInlineImages }).dispatch(
      request({ terminal: 'term_1', includeBytes: 'yes' })
    )
    expect(response.ok).toBe(false)
    expect(readTerminalInlineImages).not.toHaveBeenCalled()
  })
})
