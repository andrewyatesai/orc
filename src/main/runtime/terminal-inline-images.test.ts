// The blind-spot contract for terminal.images, plus the byte budgets.
//
// Three situations produce zero images and a driver must be able to tell them
// apart. Every one of them is asserted here, because the failure mode this verb
// exists to avoid is an empty list that reads as a fact.
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_IMAGES_DEFAULT_MAX_BYTES_PER_IMAGE,
  TERMINAL_IMAGES_DEFAULT_MAX_TOTAL_BYTES,
  TERMINAL_IMAGES_MAX_BYTES_PER_IMAGE,
  TERMINAL_IMAGES_MAX_PLACEMENTS,
  TERMINAL_IMAGES_MAX_TOTAL_BYTES,
  buildTerminalInlineImagesResult,
  type TerminalInlineImagesSource
} from './terminal-inline-images'
import type {
  EmulatorInlineImageRead,
  EmulatorInlineImageRequest
} from '../daemon/emulator-inline-images'
import type { RustInlineImage } from '../daemon/rust-terminal-addon'

function rustImage(overrides: Partial<RustInlineImage> = {}): RustInlineImage {
  return {
    row: 2,
    col: 4,
    cellRows: 3,
    cellCols: 6,
    coveredCells: 18,
    format: 'png',
    byteLen: 1024,
    zIndex: 0,
    fingerprint: '0123456789abcdef',
    payloadState: 'not-requested',
    ...overrides
  }
}

function sourceOf(
  read:
    | EmulatorInlineImageRead
    | ((request: EmulatorInlineImageRequest) => EmulatorInlineImageRead),
  overrides: Partial<TerminalInlineImagesSource> = {}
): TerminalInlineImagesSource {
  return {
    gridRows: 24,
    alternateScreen: false,
    gridCols: 80,
    scrollbackRows: 0,
    read: typeof read === 'function' ? read : () => read,
    ...overrides
  }
}

describe('buildTerminalInlineImagesResult — telling "not there" from "cannot see"', () => {
  it('reports an empty grid as available with a zero unscannable region', () => {
    const result = buildTerminalInlineImagesResult(sourceOf({ outcome: 'images', images: [] }))
    expect(result.available).toBe(true)
    expect(result.unavailable).toBeUndefined()
    expect(result.images).toEqual([])
    // Nothing has scrolled off, so the empty answer covers the whole pane.
    expect(result.unscannableHistoryRows).toBe(0)
  })

  it('sizes the region it could not scan when history exists', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({ outcome: 'images', images: [] }, { scrollbackRows: 4200 })
    )
    expect(result.available).toBe(true)
    expect(result.images).toEqual([])
    // Same empty list, entirely different claim: an image may have been there
    // and the engine discarded it on scroll-off.
    expect(result.unscannableHistoryRows).toBe(4200)
  })

  it('answers addon-too-old rather than empty when this build has no binding', () => {
    const result = buildTerminalInlineImagesResult(sourceOf({ outcome: 'unsupported' }))
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('addon-too-old')
    expect(result.images).toEqual([])
    // Not zero — unknown. A build that cannot see must not report a depth.
    expect(result.unscannableHistoryRows).toBeNull()
  })

  it('answers engine-unavailable when a live engine could not respond', () => {
    const result = buildTerminalInlineImagesResult(sourceOf({ outcome: 'unreadable' }))
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('engine-unavailable')
  })

  it('answers no-headless-engine for a pane with no live engine at all', () => {
    const result = buildTerminalInlineImagesResult(null)
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('no-headless-engine')
  })

  it('names the scroll-off blind spot on every result, including a full one', () => {
    const full = buildTerminalInlineImagesResult(
      sourceOf({ outcome: 'images', images: [rustImage()] })
    )
    expect(full.blindSpots.map((spot) => spot.reason)).toEqual(['images-dropped-on-scroll-off'])
    expect(buildTerminalInlineImagesResult(null).blindSpots).toEqual(full.blindSpots)
  })
})

describe('buildTerminalInlineImagesResult — payload bounds', () => {
  it('defaults to metadata only and passes the default budgets to the engine', () => {
    const seen: EmulatorInlineImageRequest[] = []
    const result = buildTerminalInlineImagesResult(
      sourceOf((request) => {
        seen.push(request)
        return { outcome: 'images', images: [] }
      })
    )
    expect(seen[0]).toEqual({
      includeBytes: false,
      maxBytesPerImage: TERMINAL_IMAGES_DEFAULT_MAX_BYTES_PER_IMAGE,
      maxTotalBytes: TERMINAL_IMAGES_DEFAULT_MAX_TOTAL_BYTES
    })
    expect(result.bytesRequested).toBe(false)
  })

  it('clamps an over-large request and reports the budgets it actually applied', () => {
    const seen: EmulatorInlineImageRequest[] = []
    const result = buildTerminalInlineImagesResult(
      sourceOf((request) => {
        seen.push(request)
        return { outcome: 'images', images: [] }
      }),
      { includeBytes: true, maxBytesPerImage: 1e12, maxTotalBytes: 1e12 }
    )
    expect(seen[0].maxBytesPerImage).toBe(TERMINAL_IMAGES_MAX_BYTES_PER_IMAGE)
    expect(seen[0].maxTotalBytes).toBe(TERMINAL_IMAGES_MAX_TOTAL_BYTES)
    // Echoed back so a caller learns it was clamped instead of inferring it.
    expect(result.maxBytesPerImage).toBe(TERMINAL_IMAGES_MAX_BYTES_PER_IMAGE)
    expect(result.maxTotalBytes).toBe(TERMINAL_IMAGES_MAX_TOTAL_BYTES)
  })

  it('falls back to the defaults for a non-positive or non-finite budget', () => {
    const seen: EmulatorInlineImageRequest[] = []
    buildTerminalInlineImagesResult(
      sourceOf((request) => {
        seen.push(request)
        return { outcome: 'images', images: [] }
      }),
      { maxBytesPerImage: 0, maxTotalBytes: Number.NaN }
    )
    expect(seen[0].maxBytesPerImage).toBe(TERMINAL_IMAGES_DEFAULT_MAX_BYTES_PER_IMAGE)
    expect(seen[0].maxTotalBytes).toBe(TERMINAL_IMAGES_DEFAULT_MAX_TOTAL_BYTES)
  })

  it('counts only the payloads it actually returned', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({
        outcome: 'images',
        images: [
          rustImage({ byteLen: 100, payloadState: 'included', base64: 'AAAA' }),
          rustImage({ byteLen: 900, payloadState: 'budget-exhausted' }),
          rustImage({ byteLen: 50, payloadState: 'too-large' })
        ]
      }),
      { includeBytes: true }
    )
    expect(result.bytesReturned).toBe(100)
    expect(result.images.map((image) => image.payloadState)).toEqual([
      'included',
      'budget-exhausted',
      'too-large'
    ])
    // A withheld payload carries no bytes but still declares its true size.
    expect(result.images[1].base64).toBeNull()
    expect(result.images[1].byteLength).toBe(900)
  })

  it('drops base64 that arrives against a non-included state', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({
        outcome: 'images',
        images: [rustImage({ payloadState: 'too-large', base64: 'AAAA' })]
      }),
      { includeBytes: true }
    )
    expect(result.images[0].base64).toBeNull()
  })

  it('bounds the placement list but says how many it cut', () => {
    const images = Array.from({ length: TERMINAL_IMAGES_MAX_PLACEMENTS + 25 }, () => rustImage())
    const result = buildTerminalInlineImagesResult(sourceOf({ outcome: 'images', images }))
    expect(result.images).toHaveLength(TERMINAL_IMAGES_MAX_PLACEMENTS)
    // A short list that looks complete is the same failure as a fabricated empty.
    expect(result.totalPlacements).toBe(TERMINAL_IMAGES_MAX_PLACEMENTS + 25)
  })

  it('reports totalPlacements equal to the list when nothing was cut', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({ outcome: 'images', images: [rustImage(), rustImage()] })
    )
    expect(result.totalPlacements).toBe(2)
  })
})

describe('buildTerminalInlineImagesResult — placement shape', () => {
  it('marks a placement clipped when part of its footprint is off-grid', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({
        outcome: 'images',
        images: [
          rustImage({ cellRows: 4, cellCols: 4, coveredCells: 16 }),
          rustImage({ cellRows: 4, cellCols: 4, coveredCells: 6 })
        ]
      })
    )
    expect(result.images.map((image) => image.clipped)).toEqual([false, true])
    expect(result.images[1].coveredCells).toBe(6)
  })

  it('carries the raster size for rgba8 and null for container formats', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({
        outcome: 'images',
        images: [
          rustImage({ format: 'rgba8', pixelWidth: 120, pixelHeight: 60 }),
          rustImage({ format: 'png' })
        ]
      })
    )
    expect(result.images[0]).toMatchObject({ format: 'rgba8', pixelWidth: 120, pixelHeight: 60 })
    expect(result.images[1]).toMatchObject({ format: 'png', pixelWidth: null, pixelHeight: null })
  })

  it('degrades an unrecognised format to unknown instead of asserting it through', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({
        outcome: 'images',
        images: [rustImage({ format: 'avif-from-a-future-addon' })]
      })
    )
    // A newer addon adding a format must not make THIS build claim it knows it.
    expect(result.images[0].format).toBe('unknown')
  })

  it('reports the grid the coordinates are in', () => {
    const result = buildTerminalInlineImagesResult(
      sourceOf({ outcome: 'images', images: [rustImage()] }, { gridRows: 40, gridCols: 132 })
    )
    expect({ rows: result.gridRows, cols: result.gridCols }).toEqual({ rows: 40, cols: 132 })
  })
})

describe('the alternate screen is a narrower claim', () => {
  // Every coding agent runs full-screen, so this is the normal case, not an edge one.
  it('declares the alt-screen blind spot and refuses to count the other screen history', () => {
    const result = buildTerminalInlineImagesResult(
      {
        gridRows: 40,
        gridCols: 120,
        alternateScreen: true,
        // Retained rows belong to the MAIN screen; reporting them here would answer
        // a question the caller did not ask.
        scrollbackRows: 500,
        read: () => ({ outcome: 'images', images: [] })
      },
      {}
    )

    expect(result.available).toBe(true)
    expect(result.images).toEqual([])
    expect(result.unscannableHistoryRows).toBeNull()
    expect(result.blindSpots.map((spot) => spot.reason)).toContain(
      'alt-screen-history-not-scannable'
    )
  })

  it('keeps reporting the scannable history on the main screen', () => {
    const result = buildTerminalInlineImagesResult(
      {
        gridRows: 40,
        gridCols: 120,
        alternateScreen: false,
        scrollbackRows: 500,
        read: () => ({ outcome: 'images', images: [] })
      },
      {}
    )

    expect(result.unscannableHistoryRows).toBe(500)
    expect(result.blindSpots.map((spot) => spot.reason)).not.toContain(
      'alt-screen-history-not-scannable'
    )
  })
})
