// Exercises the REAL napi addon end to end: a real PNG delivered by a real
// iTerm2 OSC-1337 sequence, and a real sixel DCS, must come back out of the
// engine as structured placements with the ORIGINAL bytes intact.
//
// A synthetic payload would prove the marshalling and nothing else. The point of
// this file is that the engine path — parse, place, retain behind the Arc,
// coalesce, cross napi — actually works on bytes a program would really emit.
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { buildTerminalInlineImagesResult } from '../runtime/terminal-inline-images'

/** A real 1x1 red PNG (68 bytes), as an encoder produced it. */
const RED_DOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const REQUEST = { includeBytes: true, maxBytesPerImage: 1 << 20, maxTotalBytes: 1 << 20 }
const METADATA_ONLY = { includeBytes: false, maxBytesPerImage: 1 << 20, maxTotalBytes: 1 << 20 }

function emulator(opts: { cols?: number; rows?: number } = {}): HeadlessEmulator {
  return new HeadlessEmulator({ cols: opts.cols ?? 40, rows: opts.rows ?? 10, scrollback: 1000 })
}

function inlineImage(base64: string, width: number, height: number): string {
  return `\x1b]1337;File=inline=1;width=${width};height=${height}:${base64}\x07`
}

describe('HeadlessEmulator.inlineImages', () => {
  it('returns one placement per image with the exact bytes the program emitted', () => {
    const term = emulator()
    term.writeSync('before\r\n')
    term.writeSync(inlineImage(RED_DOT_PNG_BASE64, 6, 3))
    const read = term.inlineImages(REQUEST)
    expect(read.outcome).toBe('images')
    if (read.outcome !== 'images') {
      throw new Error('unreachable')
    }
    expect(read.images).toHaveLength(1)
    const [image] = read.images
    expect(image.row).toBe(1)
    expect(image.col).toBe(0)
    expect({ cellRows: image.cellRows, cellCols: image.cellCols }).toEqual({
      cellRows: 3,
      cellCols: 6
    })
    // 18 cells cover the image and every one of them holds an ImageRef; a
    // per-cell result would have handed the caller 18 copies of one picture.
    expect(image.coveredCells).toBe(18)
    expect(image.format).toBe('png')
    expect(image.payloadState).toBe('included')
    expect(image.base64).toBe(RED_DOT_PNG_BASE64)
    term.dispose()
  })

  it('reports size and identity on a metadata-only read', () => {
    const term = emulator()
    term.writeSync(inlineImage(RED_DOT_PNG_BASE64, 2, 1))
    const read = term.inlineImages(METADATA_ONLY)
    if (read.outcome !== 'images') {
      throw new Error('expected images')
    }
    expect(read.images[0].payloadState).toBe('not-requested')
    expect(read.images[0].base64 ?? null).toBeNull()
    // The caller still learns what it declined, so it can decide to ask.
    expect(read.images[0].byteLen).toBe(Buffer.from(RED_DOT_PNG_BASE64, 'base64').length)
    expect(read.images[0].fingerprint).toMatch(/^[0-9a-f]{16}$/)
    term.dispose()
  })

  it('decodes a real sixel raster in-engine and reports its pixel size', () => {
    const term = emulator()
    // Six sixel columns of one green band: `#0;2;0;100;0` defines the colour,
    // `~` lights all six pixels of a column.
    term.writeSync('\x1bP0;0;0q#0;2;0;100;0#0~~~~~~\x1b\\')
    const read = term.inlineImages(METADATA_ONLY)
    if (read.outcome !== 'images') {
      throw new Error('expected images')
    }
    expect(read.images).toHaveLength(1)
    expect(read.images[0].format).toBe('rgba8')
    expect(read.images[0].pixelWidth).toBe(6)
    expect(read.images[0].pixelHeight).toBe(6)
    // Packed RGBA8: the engine decodes sixel itself because the renderer has no
    // sixel codec, so the payload is pixels, not a container.
    expect(read.images[0].byteLen).toBe(4 * 6 * 6)
    term.dispose()
  })

  it('withholds an oversized payload whole rather than returning a corrupt prefix', () => {
    const term = emulator()
    term.writeSync(inlineImage(RED_DOT_PNG_BASE64, 2, 1))
    const read = term.inlineImages({
      includeBytes: true,
      maxBytesPerImage: 8,
      maxTotalBytes: 1 << 20
    })
    if (read.outcome !== 'images') {
      throw new Error('expected images')
    }
    expect(read.images[0].payloadState).toBe('too-large')
    expect(read.images[0].base64 ?? null).toBeNull()
    expect(read.images[0].byteLen).toBeGreaterThan(8)
    term.dispose()
  })

  it('loses images on scroll-off — the blind spot callers must declare', () => {
    const term = emulator({ rows: 4 })
    term.writeSync(inlineImage(RED_DOT_PNG_BASE64, 2, 1))
    const before = term.inlineImages(METADATA_ONLY)
    expect(before.outcome === 'images' && before.images).toHaveLength(1)
    for (let i = 0; i < 12; i += 1) {
      term.writeSync(`filler ${i}\r\n`)
    }
    const after = term.inlineImages(METADATA_ONLY)
    if (after.outcome !== 'images') {
      throw new Error('expected images')
    }
    // Empty is the truth about the GRID, and a lie about the pane — which is why
    // the verb ships the retained-history depth alongside it.
    expect(after.images).toEqual([])
    expect(term.contextExtents().scrollbackRows).toBeGreaterThan(0)
    term.dispose()
  })

  it('answers unreadable, not empty, once the engine is disposed', () => {
    const term = emulator()
    term.writeSync(inlineImage(RED_DOT_PNG_BASE64, 2, 1))
    term.dispose()
    expect(term.inlineImages(METADATA_ONLY)).toEqual({ outcome: 'unreadable' })
  })
})

/** The whole main-process stack on one real image: engine -> napi -> emulator ->
 *  the runtime's result builder, i.e. exactly what `terminal.images` returns.
 *  Each layer is unit-tested on its own; this is the one that would catch them
 *  disagreeing. (The CLI face is covered in src/cli — a different tsconfig
 *  project, so it cannot be imported here.) */
describe('a real image through every layer of terminal.images', () => {
  function sourceFor(term: HeadlessEmulator) {
    const size = term.getAppliedSize()
    return {
      gridRows: size.rows,
      alternateScreen: false,
      gridCols: size.cols,
      scrollbackRows: term.contextExtents().scrollbackRows,
      read: (request: Parameters<HeadlessEmulator['inlineImages']>[0]) => term.inlineImages(request)
    }
  }

  it('carries the emitted PNG from the PTY bytes to a base64 payload and a rendered line', () => {
    const term = emulator()
    term.writeSync('$ imgcat logo.png\r\n')
    term.writeSync(inlineImage(RED_DOT_PNG_BASE64, 6, 3))
    const result = buildTerminalInlineImagesResult(sourceFor(term), { includeBytes: true })

    expect(result.available).toBe(true)
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({
      row: 1,
      col: 0,
      cellRows: 3,
      cellCols: 6,
      clipped: false,
      format: 'png',
      payloadState: 'included'
    })
    const payload = Buffer.from(result.images[0].base64 ?? '', 'base64')
    expect(payload.equals(Buffer.from(RED_DOT_PNG_BASE64, 'base64'))).toBe(true)
    // A real PNG, still a real PNG after the whole round trip.
    expect(payload.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    expect(result.bytesReturned).toBe(payload.length)
    // Nothing has scrolled yet, so this empty region is the honest claim that
    // the visible grid IS the whole pane.
    expect(result.unscannableHistoryRows).toBe(0)
    term.dispose()
  })

  it('turns the same pane into an honest "not on screen now" once it scrolls away', () => {
    const term = emulator({ rows: 4 })
    term.writeSync(inlineImage(RED_DOT_PNG_BASE64, 2, 1))
    for (let i = 0; i < 12; i += 1) {
      term.writeSync(`filler ${i}\r\n`)
    }
    const result = buildTerminalInlineImagesResult(sourceFor(term))
    expect(result.available).toBe(true)
    expect(result.images).toEqual([])
    // The pair (empty list, non-zero unscannable region) is the whole point:
    // "not on screen now", never "this pane emitted none".
    expect(result.unscannableHistoryRows).toBeGreaterThan(0)
    term.dispose()
  })
})
