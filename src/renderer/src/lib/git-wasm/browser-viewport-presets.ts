// Renderer browser viewport presets, driven by the Rust
// `orca_core::browser_viewport_presets` core through the orca-git wasm (the
// shared TS twin is now types + the preset TABLE only).
//
// PRE-READY CONTRACT — both rows are `parity`, and both fallbacks recompute the
// deleted twin's body inline from the kept `BROWSER_VIEWPORT_PRESETS` table, so
// pre-ready equals ready for EVERY input (ported-modules.md case 1: the twin's
// answer came entirely out of a constant that survives in the data-only twin).
// A `null`/sentinel here would not be distinguishable from an answer: both
// callers feed the result straight into
// `window.api.browser.setViewportOverride`, which is CDP device emulation —
// * BrowserToolbarMenu.applyViewportPreset would persist `viewportPresetId` via
//   `setBrowserPageViewportPreset` and then send `override: null`, so the menu
//   shows "Tablet" checked while the page renders desktop;
// * BrowserPane reapplies on every dom-ready, so on a terminal wasm failure the
//   user's emulated viewport is dropped on every navigation for the session.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import {
  BROWSER_VIEWPORT_PRESETS,
  type BrowserViewportPreset
} from '../../../../shared/browser-viewport-presets'
import type { BrowserViewportOverride, BrowserViewportPresetId } from '../../../../shared/types'

export function getBrowserViewportPreset(
  id: BrowserViewportPresetId | null | undefined
): BrowserViewportPreset | null {
  // Why: the twin answered a missing id `null` without consulting the table, and
  // the codec rejects a root `undefined` — so answer here rather than throwing
  // inside the dom-ready listener that reapplies the override.
  if (!id) {
    return null
  }
  if (!isGitWasmReady()) {
    return BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === id) ?? null
  }
  return dispatchToWasmCore(
    'browser-viewport-presets',
    'getBrowserViewportPreset',
    id
  ) as BrowserViewportPreset | null
}

export function browserViewportPresetToOverride(
  preset: BrowserViewportPreset
): BrowserViewportOverride {
  if (!isGitWasmReady()) {
    return {
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile
    }
  }
  // Rows only ever come from the frozen table above, so every field is a finite
  // integer/bool the codec accepts — no encode hazard to catch here.
  return dispatchToWasmCore(
    'browser-viewport-presets',
    'browserViewportPresetToOverride',
    preset
  ) as BrowserViewportOverride
}
