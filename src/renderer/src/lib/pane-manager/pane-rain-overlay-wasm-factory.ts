import type { RainOverlayEngineFactory } from './pane-rain-overlay-types'
import {
  AtermWasmRainOverlayEngine,
  type AtermWasmRainEngineDependencies
} from './pane-rain-overlay-wasm-engine'
import type {
  AtermEffectsWebModule,
  AtermEffectsWebModuleLoader
} from './pane-rain-overlay-wasm-types'

export function createAtermRainOverlayEngineFactory(
  loadModule: AtermEffectsWebModuleLoader,
  dependencies?: AtermWasmRainEngineDependencies
): RainOverlayEngineFactory {
  let modulePromise: Promise<AtermEffectsWebModule> | null = null
  return async ({ canvas, paneId, terminal }) => {
    modulePromise ??= Promise.resolve(loadModule())
    const wasm = await modulePromise
    return new AtermWasmRainOverlayEngine({ canvas, paneId, terminal, wasm, dependencies })
  }
}
