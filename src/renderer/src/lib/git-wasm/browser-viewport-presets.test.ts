// Re-pointed from the gutted src/shared/browser-viewport-presets.ts: the lookup
// and the CDP-override mapping now live in Rust (orca-core
// `browser_viewport_presets`), so these cases pin the wasm-backed shim —
// including the pre-ready values, which decide what the browser pane actually
// emulates.
import { describe, expect, it, vi } from 'vitest'
import './init-git-wasm-for-test'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from './browser-viewport-presets'
import { BROWSER_VIEWPORT_PRESETS } from '../../../../shared/browser-viewport-presets'

describe('getBrowserViewportPreset (orca-git wasm)', () => {
  it('resolves every id in the kept table to that exact row', () => {
    BROWSER_VIEWPORT_PRESETS.forEach((preset) => {
      expect(getBrowserViewportPreset(preset.id)).toEqual(preset)
    })
  })

  it('returns null for no preset and for an id that is not in the table', () => {
    expect(getBrowserViewportPreset(null)).toBeNull()
    expect(getBrowserViewportPreset(undefined)).toBeNull()
    // A persisted session from an older build can carry an id the table dropped.
    expect(getBrowserViewportPreset('nope' as never)).toBeNull()
  })
})

describe('browserViewportPresetToOverride (orca-git wasm)', () => {
  it('copies the emulation fields and drops id/label', () => {
    const tablet = getBrowserViewportPreset('tablet')!
    expect(browserViewportPresetToOverride(tablet)).toEqual({
      width: 768,
      height: 1024,
      deviceScaleFactor: 2,
      mobile: true
    })
  })

  it('keeps deviceScaleFactor 1 / mobile false on the desktop row', () => {
    const desktop = getBrowserViewportPreset('desktop')!
    expect(browserViewportPresetToOverride(desktop)).toEqual({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false
    })
  })
})

describe('before the core is ready', () => {
  it('returns the same rows and overrides the deleted TS returned, not a sentinel', async () => {
    // A fresh registry re-arms git-wasm-availability at `pending`; that is the
    // same state a terminally `unavailable` core leaves callers in.
    vi.resetModules()
    const shim = await import('./browser-viewport-presets')

    BROWSER_VIEWPORT_PRESETS.forEach((preset) => {
      expect(shim.getBrowserViewportPreset(preset.id)).toEqual(preset)
      expect(shim.browserViewportPresetToOverride(preset)).toEqual({
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile
      })
    })
    expect(shim.getBrowserViewportPreset(null)).toBeNull()
    expect(shim.getBrowserViewportPreset('nope' as never)).toBeNull()
  })

  it('never hands setViewportOverride a null override for a selected preset', async () => {
    vi.resetModules()
    const shim = await import('./browser-viewport-presets')

    // The BrowserToolbarMenu/BrowserPane shape: a null preset here would send
    // `override: null` and silently un-emulate a viewport the menu shows checked.
    const preset = shim.getBrowserViewportPreset('mobile-s')
    expect(preset ? shim.browserViewportPresetToOverride(preset) : null).toEqual({
      width: 320,
      height: 568,
      deviceScaleFactor: 2,
      mobile: true
    })
  })
})
