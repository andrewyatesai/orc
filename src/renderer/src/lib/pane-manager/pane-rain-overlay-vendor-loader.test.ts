import { describe, expect, it, vi } from 'vitest'

import {
  ATERM_EFFECTS_WEB_JS,
  ATERM_EFFECTS_WEB_WASM,
  createVendoredAtermEffectsWebLoader
} from './pane-rain-overlay-vendor-loader'
import type { AtermRainOverlayConstructor } from './pane-rain-overlay-wasm-types'

class FakeRainOverlay {}
const constructor = FakeRainOverlay as unknown as AtermRainOverlayConstructor

describe('vendored aterm effects loader', () => {
  it('does no work before first use and caches one initialized module', async () => {
    const memory = new WebAssembly.Memory({ initial: 1 })
    const initialize = vi.fn(async () => ({ memory }))
    const importGenerated = vi.fn(async () => ({
      default: initialize,
      AtermRainOverlay: constructor
    }))
    const load = createVendoredAtermEffectsWebLoader({
      baseUrl: () => 'https://orca.test/app/index.html',
      importGenerated
    })

    expect(importGenerated).not.toHaveBeenCalled()
    const [first, second] = await Promise.all([load(), load()])

    expect(importGenerated).toHaveBeenCalledOnce()
    expect(importGenerated).toHaveBeenCalledWith(`https://orca.test/app/${ATERM_EFFECTS_WEB_JS}`)
    expect(initialize).toHaveBeenCalledWith(
      new URL(`https://orca.test/app/${ATERM_EFFECTS_WEB_WASM}`)
    )
    expect(first).toBe(second)
    expect(first).toEqual({ memory, AtermRainOverlay: constructor })
  })

  it('loads packaged file-scheme wasm bytes before invoking wasm-bindgen', async () => {
    const memory = new WebAssembly.Memory({ initial: 1 })
    const bytes = new ArrayBuffer(16)
    const initialize = vi.fn(async () => ({ memory }))
    const loadFileWasm = vi.fn(async () => bytes)
    const load = createVendoredAtermEffectsWebLoader({
      baseUrl: () => 'file:///Applications/Orca/resources/app/out/renderer/index.html',
      importGenerated: async () => ({ default: initialize, AtermRainOverlay: constructor }),
      loadFileWasm
    })

    await load()

    expect(loadFileWasm).toHaveBeenCalledWith(
      new URL(
        'file:///Applications/Orca/resources/app/out/renderer/vendor/aterm-effects-web/aterm_effects_web_bg.wasm'
      )
    )
    expect(initialize).toHaveBeenCalledWith(bytes)
  })

  it('rejects a generated module that does not expose the expected ABI', async () => {
    const load = createVendoredAtermEffectsWebLoader({
      baseUrl: () => 'https://orca.test/index.html',
      importGenerated: async () => ({})
    })

    await expect(load()).rejects.toThrow('does not match the wasm-bindgen ABI')
  })
})
