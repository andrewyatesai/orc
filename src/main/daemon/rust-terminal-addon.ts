import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { isPackagedElectronProcess, orcaNodeAddonCandidatePaths } from './orca-node-addon-paths'

// Typed surface of the napi addon built from native/orca-node (the Rust
// `orca_terminal::HeadlessTerminal`). Node-API is ABI-stable, so the same
// .node loads in both plain Node and Electron without an electron-rebuild.

export type RustHeadlessTerminalHandle = {
  write(data: Buffer): void
  resize(cols: number, rows: number): void
  snapshot(): string[]
  scrollbackLen(): number
  clearScrollback(): void
  cwd(): string | null
  cursor(): number[]
  mouseTracking(): string
  sgrMouse(): boolean
  sgrPixels(): boolean
  isAlternateScreen(): boolean
  bracketedPaste(): boolean
  applicationCursor(): boolean
  /** Drop the native engine now (grid + scrollback) instead of on GC finalize. */
  dispose(): void
  /** Window title (OSC 0/2), or null when unset. */
  title(): string | null
  /** Replayable ANSI: `scrollbackRows` caps the prepended history (omit = all,
   *  0 = viewport-only). */
  serializeAnsi(scrollbackRows?: number): string
  /** Scrollback history only; `maxRows` caps to the most-recent N lines. */
  serializeScrollbackAnsi(maxRows?: number): string
  /** OSC-8 hyperlink ranges over the serialized window (matches the renderer's
   *  `TerminalOscLinkRange`; `endCol` exclusive). */
  oscLinkRanges(scrollbackRows?: number): TerminalOscLinkRange[]
  /** E-5 federated search over history + visible grid: newest-first summaries,
   *  the true total, and the truncation honesty flag. Invalid regex = zero
   *  matches. `cutoffRow` keeps only rows strictly older than it. `originRow`
   *  (fed §2.4; absent on pre-Wave-5 addons — feature-detect) is the stable
   *  absolute row of retained index 0 in the same settled state as the
   *  matches, so `originRow + absRow` is an eviction-stable host row. */
  searchScrollback(
    query: string,
    caseSensitive?: boolean,
    regex?: boolean,
    maxMatches?: number,
    cutoffRow?: number
  ): {
    matches: { absRow: number; col: number; len: number; line: string }[]
    total: number
    incomplete: boolean
    originRow?: number
  }
  /** Context lines around an absolute row, clamped to retained content.
   *  `originRow`: same stable-row contract as `searchScrollback`. */
  searchContext(
    absRow: number,
    before: number,
    after: number
  ): { lines: string[]; firstAbsRow: number; originRow?: number }
  /** Stable absolute row of retained history index 0 (fed §2.4 remote wire):
   *  monotonic across eviction/clear, settled before read. Absent on
   *  pre-Wave-5 addons — callers must feature-detect. */
  retainedOriginRow?(): number
  /** Inline images (OSC-1337 / sixel / Kitty) on the VISIBLE grid, one entry per
   *  placement, in reading order. Empty means "none on screen now" — the engine
   *  drops image refs on scroll-off, so it never means "none were emitted".
   *  Metadata-only unless `includeBytes`; oversized payloads are withheld whole
   *  (`payloadState`), never truncated. Absent on addons built before
   *  `terminal.images` — callers must feature-detect, because a missing binding
   *  is "cannot see", not "nothing there". */
  inlineImages?(
    includeBytes?: boolean,
    maxBytesPerImage?: number,
    maxTotalBytes?: number
  ): RustInlineImage[]
  /** The styled VISIBLE grid plus cursor and input-affecting modes
   *  (`terminal.screen`). Colours are engine-resolved (`#rrggbb`), cells are
   *  coalesced into style runs, and the raw SGR bits ride along as `attrs`
   *  codes. `detail: 'full'` pads rows to the grid width and attaches OSC-8
   *  targets. Null means the engine is disposed — never a zeroed frame, which
   *  would describe a blank screen. Absent on addons built before
   *  `terminal.screen`; callers must feature-detect, because a missing binding
   *  is "cannot see", not "the screen is blank". */
  styledFrame?(
    detail?: string,
    fromRow?: number,
    rowCount?: number,
    maxRuns?: number
  ): RustStyledFrame | null
  /** One keystroke encoded against this pane's LIVE keyboard modes
   *  (`terminal.key`). `key` is a DOM `KeyboardEvent.key` value; `mods` is the
   *  engine `Modifiers` bitfield (SHIFT=1, ALT=2, CTRL=4, SUPER=8). The engine
   *  decides the bytes, because DECCKM, the negotiated Kitty flags, xterm
   *  modifyOtherKeys and DECBKM all change them for the same key. Null means
   *  the engine is disposed — never a zeroed encoding, which would read as "this
   *  key means nothing here". Absent on addons built before `terminal.key`;
   *  callers must feature-detect, because a missing binding is "cannot encode",
   *  not "no such key". */
  encodeKey?(key: string, mods: number): RustKeyEncoding | null
}

/** One keystroke as the addon marshals it. `recognized` is separate from the
 *  byte count on purpose: an unknown name and a key these modes leave unencodable
 *  are different facts, and only one of them is the caller's mistake. */
export type RustKeyEncoding = {
  recognized: boolean
  /** Key-down bytes. Empty on a recognized key = no encoding in these modes. */
  press: Buffer
  /** Key-up bytes; empty unless the pane negotiated Kitty `REPORT_EVENT_TYPES`. */
  release: Buffer
  /** Raw `KeyboardMode` bits the encoding was made against. */
  modeBits: number
}

/** One run of cells sharing a resolved style, as the addon marshals it. */
export type RustStyleRun = {
  col: number
  /** Columns spanned; exceeds the grapheme count of `text` across wide glyphs. */
  cols: number
  text: string
  /** Resolved, as rendered — `#rrggbb`. */
  fg: string
  bg: string
  /** Raw SGR bits as code letters (orca_terminal's `SCREEN_ATTR_CODES`). */
  attrs: string
  hyperlink?: string | null
}

export type RustStyledRow = {
  row: number
  runs: RustStyleRun[]
}

export type RustStyledFrame = {
  rows: number
  cols: number
  firstRow: number
  rowsTruncated: boolean
  runsTotal: number
  trailingBlanksTrimmed: boolean
  defaultFg: string
  defaultBg: string
  cursor: { row: number; col: number; visible: boolean; style: string }
  modes: {
    alternateScreen: boolean
    applicationCursor: boolean
    bracketedPaste: boolean
    mouseTracking: string
    sgrMouse: boolean
    sgrPixels: boolean
    /** Coordinate encoding by name: x10 | utf8 | sgr | urxvt | sgr-pixel | unknown. */
    mouseEncoding: string
    kittyKeyboardFlags: number
    reverseVideo: boolean
  }
  contentSeq: number
  grid: RustStyledRow[]
}

/** One inline-image placement as the addon marshals it. */
export type RustInlineImage = {
  row: number
  col: number
  cellRows: number
  cellCols: number
  coveredCells: number
  format: string
  pixelWidth?: number | null
  pixelHeight?: number | null
  byteLen: number
  zIndex: number
  fingerprint: string
  payloadState: string
  base64?: string | null
}

export type RustHeadlessTerminalCtor = new (
  cols: number,
  rows: number,
  scrollback?: number
) => RustHeadlessTerminalHandle

export type RustTerminalBinding = {
  HeadlessTerminal: RustHeadlessTerminalCtor
  engine(): string
}

function candidatePaths(): string[] {
  return orcaNodeAddonCandidatePaths({
    override: process.env.ORCA_RUST_TERMINAL_ADDON,
    // Why: packaged builds must never probe cwd — a stale dev addon under the
    // launch directory would silently replace the shipped engine.
    isPackaged: isPackagedElectronProcess(),
    cwd: process.cwd(),
    // resourcesPath is Electron-only, so read it defensively rather than via
    // the global type.
    resourcesPath: (process as { resourcesPath?: string }).resourcesPath
  })
}

let cached: RustTerminalBinding | null | undefined
let failureDetail: string[] = []

/** Why the last `loadRustTerminalBinding()` returned null, one entry per
 *  candidate path. Empty until a load has been attempted and failed. */
export function rustTerminalLoadFailures(): string[] {
  return failureDetail
}

/** Load the Rust terminal addon, or return null if it is unavailable or fails
 *  to load. Never throws itself, but there is NO fallback engine — callers
 *  treat null as a fatal build/packaging fault, using
 *  `rustTerminalLoadFailures()` for the per-candidate causes. */
export function loadRustTerminalBinding(): RustTerminalBinding | null {
  if (cached !== undefined) {
    return cached
  }
  const req = createRequire(import.meta.url)
  const failures: string[] = []
  for (const path of candidatePaths()) {
    if (!existsSync(path)) {
      failures.push(`${path}: not found`)
      continue
    }
    try {
      const binding = req(path) as RustTerminalBinding
      if (binding && typeof binding.HeadlessTerminal === 'function') {
        cached = binding
        return cached
      }
      failures.push(`${path}: loaded but exports no HeadlessTerminal constructor`)
    } catch (error) {
      // Keep the real cause (e.g. an ABI/NODE_MODULE_VERSION mismatch) so the
      // caller's fatal error names it instead of a generic 'failed to load'.
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  failureDetail = failures
  cached = null
  return cached
}
