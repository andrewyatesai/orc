// The blind-spot contract for terminal.screen, plus the run budget and the
// compaction rules.
//
// The failure this verb exists to avoid: a frame that a driver acts on without
// knowing it was cut, or an empty grid that reads as "the screen is blank" when
// the truth is "this build cannot read screens". Both are asserted here.
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_SCREEN_DEFAULT_MAX_RUNS,
  TERMINAL_SCREEN_MAX_RUNS,
  buildTerminalScreenResult,
  type TerminalScreenSource
} from './terminal-screen'
import type {
  EmulatorStyledFrameRead,
  EmulatorStyledFrameRequest
} from '../daemon/emulator-styled-frame'
import type { RustStyleRun, RustStyledFrame } from '../daemon/rust-terminal-addon'

const DEFAULT_FG = '#c0c0c0'
const DEFAULT_BG = '#000000'

function run(overrides: Partial<RustStyleRun> = {}): RustStyleRun {
  return {
    col: 0,
    cols: 5,
    text: 'hello',
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    attrs: '',
    ...overrides
  }
}

function frame(overrides: Partial<RustStyledFrame> = {}): RustStyledFrame {
  return {
    rows: 24,
    cols: 80,
    firstRow: 0,
    rowsTruncated: false,
    runsTotal: 1,
    trailingBlanksTrimmed: true,
    defaultFg: DEFAULT_FG,
    defaultBg: DEFAULT_BG,
    cursor: { row: 3, col: 12, visible: true, style: 'steady-bar' },
    modes: {
      alternateScreen: false,
      applicationCursor: false,
      bracketedPaste: false,
      mouseTracking: 'none',
      sgrMouse: false,
      sgrPixels: false,
      mouseEncoding: 'sgr',
      kittyKeyboardFlags: 0,
      reverseVideo: false
    },
    contentSeq: 42,
    grid: [{ row: 0, runs: [run()] }],
    ...overrides
  }
}

function sourceOf(
  read: EmulatorStyledFrameRead | ((request: EmulatorStyledFrameRequest) => EmulatorStyledFrameRead)
): TerminalScreenSource {
  return { read: typeof read === 'function' ? read : () => read }
}

describe('buildTerminalScreenResult — telling "blank" from "cannot see"', () => {
  it('reports a genuinely blank grid as available with an empty, untruncated frame', () => {
    const result = buildTerminalScreenResult(
      sourceOf({ outcome: 'frame', frame: frame({ grid: [], runsTotal: 0 }) })
    )
    expect(result.available).toBe(true)
    expect(result.unavailable).toBeUndefined()
    expect(result.rows).toEqual([])
    // The whole screen was served — it is simply empty.
    expect(result.rowsTruncated).toBe(false)
    expect(result.gridRows).toBe(24)
  })

  it('answers addon-too-old rather than an empty grid when this build has no binding', () => {
    const result = buildTerminalScreenResult(sourceOf({ outcome: 'unsupported' }))
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('addon-too-old')
    expect(result.rows).toEqual([])
    // Not zero, not false — unknown. Nothing was read, so nothing is claimed.
    expect(result.gridRows).toBeNull()
    expect(result.cursor).toBeNull()
    expect(result.modes).toBeNull()
    expect(result.contentSeq).toBeNull()
    expect(result.rowsTruncated).toBe(false)
  })

  it('answers engine-unavailable when a live engine could not respond', () => {
    const result = buildTerminalScreenResult(sourceOf({ outcome: 'unreadable' }))
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('engine-unavailable')
  })

  it('answers no-headless-engine for a pane with no live engine at all', () => {
    const result = buildTerminalScreenResult(null)
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('no-headless-engine')
  })

  it('names the styled-history and inline-image blind spots on every result', () => {
    const served = buildTerminalScreenResult(sourceOf({ outcome: 'frame', frame: frame() }))
    expect(served.blindSpots.map((spot) => spot.reason)).toEqual([
      'styled-grid-is-visible-only',
      'images-not-in-styled-cells'
    ])
    // Including when nothing could be read: the caller still needs to know what
    // this seam structurally cannot show.
    expect(buildTerminalScreenResult(null).blindSpots).toEqual(served.blindSpots)
  })
})

describe('buildTerminalScreenResult — run shape', () => {
  it('omits fg and bg that match the frame default and states the default once', () => {
    const result = buildTerminalScreenResult(sourceOf({ outcome: 'frame', frame: frame() }))
    const only = result.rows[0].runs[0]
    expect(only.fg).toBeUndefined()
    expect(only.bg).toBeUndefined()
    expect({ fg: result.defaultFg, bg: result.defaultBg }).toEqual({
      fg: DEFAULT_FG,
      bg: DEFAULT_BG
    })
  })

  it('keeps a colour that differs from the default', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({
          grid: [{ row: 0, runs: [run({ fg: '#ff0000', bg: '#0000ff' })] }]
        })
      })
    )
    expect(result.rows[0].runs[0]).toMatchObject({ fg: '#ff0000', bg: '#0000ff' })
  })

  it('expands the attribute codes into names and omits an empty set', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({
          grid: [
            {
              row: 0,
              runs: [run({ attrs: 'bvw' }), run({ col: 5, attrs: '' })]
            }
          ]
        })
      })
    )
    expect(result.rows[0].runs[0].attrs).toEqual(['bold', 'inverse', 'underline-curly'])
    expect(result.rows[0].runs[1].attrs).toBeUndefined()
  })

  it('drops an attribute code this build does not know rather than inventing a name', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({ grid: [{ row: 0, runs: [run({ attrs: 'bZ' })] }] })
      })
    )
    expect(result.rows[0].runs[0].attrs).toEqual(['bold'])
  })

  it('carries a hyperlink only when the addon supplied one', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({
          grid: [
            {
              row: 0,
              runs: [run({ hyperlink: 'https://example.com' }), run({ col: 5, hyperlink: null })]
            }
          ]
        })
      })
    )
    expect(result.rows[0].runs[0].link).toBe('https://example.com')
    expect(result.rows[0].runs[1].link).toBeUndefined()
  })

  it('keeps the column span of a wide glyph distinct from its text length', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({ grid: [{ row: 0, runs: [run({ text: 'a漢b', cols: 4 })] }] })
      })
    )
    // 3 graphemes over 4 columns: the wide glyph's continuation column has no
    // text of its own, and a caller computing a click target needs the columns.
    expect(result.rows[0].runs[0]).toMatchObject({ text: 'a漢b', cols: 4 })
  })

  it('preserves each row index so a windowed frame stays addressable', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({
          firstRow: 10,
          rowsTruncated: true,
          grid: [
            { row: 10, runs: [run()] },
            { row: 11, runs: [run()] }
          ]
        })
      })
    )
    expect(result.rows.map((row) => row.row)).toEqual([10, 11])
    expect(result.firstRow).toBe(10)
    expect(result.rowsTruncated).toBe(true)
  })
})

describe('buildTerminalScreenResult — cursor and modes', () => {
  it('passes the cursor through, including a hidden one that still has a position', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({ cursor: { row: 7, col: 2, visible: false, style: 'hidden' } })
      })
    )
    expect(result.cursor).toEqual({ row: 7, col: 2, visible: false, style: 'hidden' })
  })

  it('reports the modes that change what input means', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({
          modes: {
            alternateScreen: true,
            applicationCursor: true,
            bracketedPaste: true,
            mouseTracking: 'any',
            sgrMouse: true,
            sgrPixels: false,
            mouseEncoding: 'sgr',
            kittyKeyboardFlags: 5,
            reverseVideo: true
          }
        })
      })
    )
    expect(result.modes).toMatchObject({
      alternateScreen: true,
      applicationCursor: true,
      bracketedPaste: true,
      mouseTracking: 'any',
      kittyKeyboardFlags: 5,
      reverseVideo: true
    })
  })

  it('degrades an unknown mouse mode to unknown, never to none', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({
          modes: { ...frame().modes, mouseTracking: 'some-future-mode' }
        })
      })
    )
    // 'none' would tell a driver its clicks need no encoding. That is a claim,
    // and this build has not earned it.
    expect(result.modes?.mouseTracking).toBe('unknown')
  })
})

describe('buildTerminalScreenResult — request shaping and budgets', () => {
  it('defaults to a compact, whole-screen read with the default run budget', () => {
    const seen: EmulatorStyledFrameRequest[] = []
    const result = buildTerminalScreenResult(
      sourceOf((request) => {
        seen.push(request)
        return { outcome: 'frame', frame: frame() }
      })
    )
    expect(seen[0]).toEqual({
      detail: 'compact',
      fromRow: 0,
      rowCount: 0,
      maxRuns: TERMINAL_SCREEN_DEFAULT_MAX_RUNS
    })
    expect(result.detail).toBe('compact')
    expect(result.maxRuns).toBe(TERMINAL_SCREEN_DEFAULT_MAX_RUNS)
  })

  it('forwards a full-detail windowed request', () => {
    const seen: EmulatorStyledFrameRequest[] = []
    buildTerminalScreenResult(
      sourceOf((request) => {
        seen.push(request)
        return { outcome: 'frame', frame: frame() }
      }),
      { detail: 'full', fromRow: 12, rowCount: 6, maxRuns: 500 }
    )
    expect(seen[0]).toEqual({ detail: 'full', fromRow: 12, rowCount: 6, maxRuns: 500 })
  })

  it('clamps an over-large run budget and reports the one it applied', () => {
    const seen: EmulatorStyledFrameRequest[] = []
    const result = buildTerminalScreenResult(
      sourceOf((request) => {
        seen.push(request)
        return { outcome: 'frame', frame: frame() }
      }),
      { maxRuns: 1e9 }
    )
    expect(seen[0].maxRuns).toBe(TERMINAL_SCREEN_MAX_RUNS)
    // Echoed back so a caller learns it was clamped instead of inferring it.
    expect(result.maxRuns).toBe(TERMINAL_SCREEN_MAX_RUNS)
  })

  it('falls back to the defaults for non-finite or non-positive bounds', () => {
    const seen: EmulatorStyledFrameRequest[] = []
    buildTerminalScreenResult(
      sourceOf((request) => {
        seen.push(request)
        return { outcome: 'frame', frame: frame() }
      }),
      { maxRuns: Number.NaN, rowCount: -4, fromRow: Number.POSITIVE_INFINITY }
    )
    expect(seen[0]).toEqual({
      detail: 'compact',
      fromRow: 0,
      rowCount: 0,
      maxRuns: TERMINAL_SCREEN_DEFAULT_MAX_RUNS
    })
  })

  it('surfaces the truncation the engine reported alongside the runs it served', () => {
    const result = buildTerminalScreenResult(
      sourceOf({
        outcome: 'frame',
        frame: frame({ rowsTruncated: true, runsTotal: 4000 })
      }),
      { maxRuns: 4000 }
    )
    expect(result.rowsTruncated).toBe(true)
    expect(result.runsReturned).toBe(4000)
  })

  it('reports the trailing-blank trim so a caller rebuilding a matrix pads', () => {
    const compact = buildTerminalScreenResult(sourceOf({ outcome: 'frame', frame: frame() }))
    expect(compact.trailingBlanksTrimmed).toBe(true)
    const full = buildTerminalScreenResult(
      sourceOf({ outcome: 'frame', frame: frame({ trailingBlanksTrimmed: false }) }),
      { detail: 'full' }
    )
    expect(full.trailingBlanksTrimmed).toBe(false)
  })
})
