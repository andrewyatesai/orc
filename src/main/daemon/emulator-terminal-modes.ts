// The mode set a snapshot carries, assembled from its two authorities — split
// from headless-emulator.ts (line budget), like the search / context-extents /
// inline-image bridges beside it.
//
// Two authorities, deliberately: screen and input modes come from the aterm
// engine, while mouse and kitty-keyboard modes are scanned off the raw byte
// stream because the napi surface does not carry them and they must survive
// into snapshots. Keeping the split visible here is the point of the module.
import type { TerminalModes } from './types'
import type { RustHeadlessTerminalHandle } from './rust-terminal-addon'

export type EmulatorModeScanners = {
  mouseTrackingMode: () => TerminalModes['mouseTrackingMode']
  sgrMouseMode: () => boolean
  sgrMousePixelsMode: () => boolean
  kittyKeyboardFlags: number
}

export type EmulatorEngineModes = Pick<
  TerminalModes,
  'bracketedPaste' | 'applicationCursor' | 'alternateScreen'
>

/** All false — what a poisoned engine reports, so a degraded snapshot never
 *  claims a mode it could not read. */
export const UNREADABLE_ENGINE_MODES: EmulatorEngineModes = {
  bracketedPaste: false,
  applicationCursor: false,
  alternateScreen: false
}

export function readEngineModes(term: RustHeadlessTerminalHandle): EmulatorEngineModes {
  return {
    bracketedPaste: term.bracketedPaste(),
    applicationCursor: term.applicationCursor(),
    alternateScreen: term.isAlternateScreen()
  }
}

export function combineTerminalModes(
  engineModes: EmulatorEngineModes,
  scanners: EmulatorModeScanners
): TerminalModes {
  const mouseTrackingMode = scanners.mouseTrackingMode()
  return {
    ...engineModes,
    mouseTracking: mouseTrackingMode !== 'none',
    mouseTrackingMode,
    sgrMouseMode: scanners.sgrMouseMode(),
    sgrMousePixelsMode: scanners.sgrMousePixelsMode(),
    // Deliberately NOT part of rehydrate — the renderer re-negotiates the kitty
    // protocol on reconnect; this is here so the query responder can re-seed.
    kittyKeyboardFlags: scanners.kittyKeyboardFlags
  }
}
