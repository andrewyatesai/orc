import type { AtermGpuTerminal } from './aterm_gpu_web.js'
import wasmUrl from './aterm_gpu_web_bg.wasm?url'
import { loadAtermFontBytes } from './load-aterm-font'
import { registerAtermGpuGlue } from './aterm-wasm-module-registry'

export type LoadedAtermGpu = {
  AtermGpuTerminal: typeof AtermGpuTerminal
  fontBytes: Uint8Array
  /** The GPU wasm module's linear memory (its OWN instance, separate from
   *  aterm-wasm's) — the spill blit reads the chrome-band export through it. */
  memory: WebAssembly.Memory
}

// Why: the GPU wasm module and the font are immutable, shared assets; load them
// once and hand the same result to every pane that opens the aterm GPU path.
// Mirrors load-aterm.ts (the CPU path) — same font bytes, same ?url wasm asset,
// so both engines size cells identically and a GPU↔CPU fallback is seamless.
let loadPromise: Promise<LoadedAtermGpu> | null = null

async function loadAtermGpuOnce(): Promise<LoadedAtermGpu> {
  // Share the font fetch with the CPU loader (load-aterm-font) so the face is
  // fetched once and a GPU→CPU swap reuses these bytes instead of re-fetching.
  // The glue module is dynamic-imported so it stays out of the eager entry chunk.
  const [glue, fontBytes] = await Promise.all([import('./aterm_gpu_web.js'), loadAtermFontBytes()])
  registerAtermGpuGlue(glue)
  const initOutput = await glue.default({ module_or_path: wasmUrl })
  return { AtermGpuTerminal: glue.AtermGpuTerminal, fontBytes, memory: initOutput.memory }
}

export async function loadAtermGpu(): Promise<LoadedAtermGpu> {
  loadPromise ??= loadAtermGpuOnce()
  return loadPromise
}
