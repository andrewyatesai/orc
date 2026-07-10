import type { RainOverlayEngineFactory } from './pane-rain-overlay-types'
import type {
  AtermEffectsWebModule,
  AtermEffectsWebModuleLoader,
  AtermRainOverlayConstructor
} from './pane-rain-overlay-wasm-types'

const VENDOR_PATH = 'vendor/aterm-effects-web/'
export const ATERM_EFFECTS_WEB_JS = `${VENDOR_PATH}aterm_effects_web.js`
export const ATERM_EFFECTS_WEB_WASM = `${VENDOR_PATH}aterm_effects_web_bg.wasm`

type VendorLoaderDependencies = {
  readonly baseUrl?: () => string
  readonly importGenerated?: (url: string) => Promise<unknown>
  readonly loadFileWasm?: (url: URL) => Promise<ArrayBuffer>
}

type GeneratedBindings = {
  readonly default: (wasmInput: URL | ArrayBuffer) => Promise<unknown>
  readonly AtermRainOverlay: AtermRainOverlayConstructor
}

function checkedBindings(value: unknown): GeneratedBindings {
  if (!value || typeof value !== 'object') {
    throw new Error('aterm effects vendor module has no exports')
  }
  const exports = value as Record<string, unknown>
  if (typeof exports.default !== 'function' || typeof exports.AtermRainOverlay !== 'function') {
    throw new Error('aterm effects vendor module does not match the wasm-bindgen ABI')
  }
  return exports as GeneratedBindings
}

function checkedMemory(value: unknown): WebAssembly.Memory {
  if (!value || typeof value !== 'object') {
    throw new Error('aterm effects initialization returned no wasm exports')
  }
  const memory = (value as { memory?: unknown }).memory
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('aterm effects initialization returned no wasm memory')
  }
  return memory
}

function loadFileWasm(url: URL): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('GET', url.href)
    request.responseType = 'arraybuffer'
    request.addEventListener('load', () => {
      if (request.status === 0 || (request.status >= 200 && request.status < 300)) {
        if (request.response instanceof ArrayBuffer) {
          resolve(request.response)
        } else {
          reject(new Error('aterm effects wasm load returned no bytes'))
        }
      } else {
        reject(new Error(`aterm effects wasm load failed with status ${request.status}`))
      }
    })
    request.addEventListener('error', () => reject(new Error('aterm effects wasm load failed')))
    request.send()
  })
}

export function createVendoredAtermEffectsWebLoader(
  dependencies: VendorLoaderDependencies = {}
): AtermEffectsWebModuleLoader {
  let modulePromise: Promise<AtermEffectsWebModule> | null = null
  return () => {
    modulePromise ??= (async () => {
      const baseUrl = dependencies.baseUrl?.() ?? globalThis.location?.href ?? import.meta.url
      const javascriptUrl = new URL(ATERM_EFFECTS_WEB_JS, baseUrl).href
      const wasmUrl = new URL(ATERM_EFFECTS_WEB_WASM, baseUrl)
      const imported = dependencies.importGenerated
        ? await dependencies.importGenerated(javascriptUrl)
        : await import(/* @vite-ignore */ javascriptUrl)
      const bindings = checkedBindings(imported)
      const wasmInput =
        wasmUrl.protocol === 'file:'
          ? await (dependencies.loadFileWasm ?? loadFileWasm)(wasmUrl)
          : wasmUrl
      const initialized = await bindings.default(wasmInput)
      return {
        memory: checkedMemory(initialized),
        AtermRainOverlay: bindings.AtermRainOverlay
      }
    })()
    return modulePromise
  }
}

const loadVendoredAtermEffectsWeb = createVendoredAtermEffectsWebLoader()

export const vendoredAtermRainOverlayEngineFactory: RainOverlayEngineFactory = async (args) => {
  const [wasm, engineModule] = await Promise.all([
    loadVendoredAtermEffectsWeb(),
    import('./pane-rain-overlay-wasm-engine')
  ])
  return new engineModule.AtermWasmRainOverlayEngine({ ...args, wasm })
}
