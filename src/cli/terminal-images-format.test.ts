// The plain-text view has to preserve the distinction the JSON shape encodes:
// three different situations produce zero images, and a human (or an agent
// reading non-JSON output) must be able to tell which one happened.
import { describe, expect, it } from 'vitest'
import { formatTerminalImages } from './terminal-images-format'
import type {
  TerminalInlineImage,
  TerminalInlineImagesResult
} from '../shared/terminal-inline-images-protocol'

function image(overrides: Partial<TerminalInlineImage> = {}): TerminalInlineImage {
  return {
    row: 3,
    col: 0,
    cellRows: 4,
    cellCols: 8,
    coveredCells: 32,
    clipped: false,
    format: 'png',
    pixelWidth: null,
    pixelHeight: null,
    byteLength: 2048,
    zIndex: 0,
    fingerprint: 'abcdef0123456789',
    payloadState: 'not-requested',
    base64: null,
    ...overrides
  }
}

function result(overrides: Partial<TerminalInlineImagesResult> = {}): TerminalInlineImagesResult {
  return {
    schema: 1,
    available: true,
    images: [],
    totalPlacements: 0,
    gridRows: 24,
    gridCols: 80,
    unscannableHistoryRows: 0,
    bytesRequested: false,
    maxBytesPerImage: 262144,
    maxTotalBytes: 1048576,
    bytesReturned: 0,
    blindSpots: [],
    ...overrides
  }
}

describe('formatTerminalImages', () => {
  it('says an empty pane with no history IS the whole picture', () => {
    const text = formatTerminalImages(result())
    expect(text).toContain('No inline images on the visible grid')
    expect(text).toContain('nothing has scrolled off')
  })

  it('says an empty pane WITH history is only the visible grid', () => {
    const text = formatTerminalImages(result({ unscannableHistoryRows: 1500 }))
    expect(text).toContain('No inline images on the visible grid')
    expect(text).toContain('1500 row(s) have scrolled into history')
    expect(text).toContain('unrecoverable')
  })

  it('does not claim a scan depth it could not read', () => {
    const text = formatTerminalImages(result({ unscannableHistoryRows: null }))
    expect(text).toContain('History depth is unreadable')
  })

  it('distinguishes a build that cannot see images from a pane with none', () => {
    const text = formatTerminalImages(result({ available: false, unavailable: 'addon-too-old' }))
    expect(text).toContain('Images unavailable: addon-too-old')
    expect(text).toContain('cannot see inline images at all')
    expect(text).not.toContain('No inline images')
  })

  it('distinguishes a parked pane from a pane with none', () => {
    const text = formatTerminalImages(
      result({ available: false, unavailable: 'no-headless-engine' })
    )
    expect(text).toContain('not that it has no images')
  })

  it('says when the per-response cap cut the list', () => {
    const text = formatTerminalImages(result({ images: [image()], totalPlacements: 40 }))
    expect(text).toContain('showing 1 of 40')
    expect(text).toContain('cut by the per-response cap')
  })

  it('renders position, footprint, size and identity for each placement', () => {
    const text = formatTerminalImages(result({ images: [image()], totalPlacements: 1 }))
    expect(text).toContain('#0  at row 3 col 0  png  8x4 cells')
    expect(text).toContain('2048 bytes  fingerprint abcdef0123456789')
    expect(text).toContain('metadata only (--bytes for the payload)')
  })

  it('shows the raster size for a decoded sixel', () => {
    const text = formatTerminalImages(
      result({ images: [image({ format: 'rgba8', pixelWidth: 96, pixelHeight: 48 })] })
    )
    expect(text).toContain('rgba8  8x4 cells, 96x48px')
  })

  it('names the cause and the flag that lifts it when bytes were withheld', () => {
    const text = formatTerminalImages(
      result({
        bytesRequested: true,
        images: [image({ payloadState: 'too-large' }), image({ payloadState: 'budget-exhausted' })]
      })
    )
    expect(text).toContain('over the per-image cap (raise --max-bytes)')
    expect(text).toContain('the total budget was spent (raise --max-total-bytes)')
  })

  it('reports how many payload bytes came back when bytes were asked for', () => {
    const text = formatTerminalImages(
      result({
        bytesRequested: true,
        bytesReturned: 2048,
        images: [image({ payloadState: 'included', base64: 'AAAA' })]
      })
    )
    expect(text).toContain('2048 payload bytes returned')
  })

  it('flags a clipped placement with how much of it is on screen', () => {
    const text = formatTerminalImages(
      result({ images: [image({ clipped: true, coveredCells: 9 })] })
    )
    expect(text).toContain('clipped (9 of 32 cells on screen)')
  })
})
