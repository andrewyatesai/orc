// Types + the preset TABLE only: the lookup and the CDP-override mapping now run
// in Rust (orca-core `browser_viewport_presets`), reached from the renderer
// through src/renderer/src/lib/git-wasm/browser-viewport-presets.ts. The table
// stays here because it is data — the dropdown renders it directly, and the
// shim's pre-ready fallback reads it to reproduce the deleted functions exactly.
import type { BrowserViewportPresetId } from './types'

export type BrowserViewportPreset = {
  id: BrowserViewportPresetId
  label: string
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

// Why: deviceScaleFactor=2 on mobile/tablet mirrors Chrome's device toolbar so
// retina-aware sites pick the correct asset tier; mobile=true enables touch
// emulation + small-viewport CSS. Dimensions match Chrome DevTools presets.
export const BROWSER_VIEWPORT_PRESETS = [
  {
    id: 'mobile-s',
    label: 'Mobile S — 320 × 568',
    width: 320,
    height: 568,
    deviceScaleFactor: 2,
    mobile: true
  },
  {
    id: 'mobile-m',
    label: 'Mobile M — 375 × 667',
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true
  },
  {
    id: 'mobile-l',
    label: 'Mobile L — 425 × 812',
    width: 425,
    height: 812,
    deviceScaleFactor: 2,
    mobile: true
  },
  {
    id: 'tablet',
    label: 'Tablet — 768 × 1024',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true
  },
  {
    id: 'laptop',
    label: 'Laptop — 1024 × 768',
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false
  },
  {
    id: 'laptop-l',
    label: 'Laptop L — 1440 × 900',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  },
  {
    id: 'desktop',
    label: 'Desktop — 1920 × 1080',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  }
] as const satisfies readonly BrowserViewportPreset[]
