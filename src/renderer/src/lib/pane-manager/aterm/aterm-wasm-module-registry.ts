import type * as AtermCpuGlue from './aterm_wasm.js'
import type * as AtermGpuGlue from './aterm_gpu_web.js'

// Why: the wasm-bindgen glue modules (~285KB minified JS combined) must not be
// statically reachable from the renderer entry — they cost eager parse on every
// cold start even when no terminal exists yet. load-aterm(-gpu).ts dynamic-imports
// each glue once and registers it here; the synchronous consumers (key encoders,
// fallback-font injection) only ever run against a live engine instance, which
// cannot exist before the corresponding load resolved.

let cpuGlue: typeof AtermCpuGlue | null = null
let gpuGlue: typeof AtermGpuGlue | null = null

export function registerAtermCpuGlue(module: typeof AtermCpuGlue): void {
  cpuGlue = module
}

export function registerAtermGpuGlue(module: typeof AtermGpuGlue): void {
  gpuGlue = module
}

export function atermCpuGlue(): typeof AtermCpuGlue {
  if (!cpuGlue) {
    throw new Error('aterm CPU wasm glue not loaded — loadAterm() must resolve first')
  }
  return cpuGlue
}

export function atermGpuGlue(): typeof AtermGpuGlue {
  if (!gpuGlue) {
    throw new Error('aterm GPU wasm glue not loaded — loadAtermGpu() must resolve first')
  }
  return gpuGlue
}
