import type { AtermTerminal } from './aterm_wasm.js'
import wasmUrl from './aterm_wasm_bg.wasm?url'
import { loadAtermFontBytes } from './load-aterm-font'
import { registerAtermCpuGlue } from './aterm-wasm-module-registry'

export type LoadedAterm = {
  AtermTerminal: typeof AtermTerminal
  fontBytes: Uint8Array
  /** The wasm module's linear memory — ONE shared instance across all panes (the
   *  module is instantiated once). e2e memory bench reads buffer.byteLength to size
   *  per-pane growth; production code never needs it. */
  memory: WebAssembly.Memory
}

// Why: the wasm module and the font are both immutable, shared assets; load
// them once and hand the same result to every pane that opens the aterm path.
let loadPromise: Promise<LoadedAterm> | null = null

async function loadAtermOnce(): Promise<LoadedAterm> {
  // Share the font fetch with the GPU loader so a GPU→CPU context-loss swap never
  // re-fetches the face (that duplicate fetch was observed to hang in the swap).
  // The glue module is dynamic-imported so it stays out of the eager entry chunk.
  const [glue, fontBytes] = await Promise.all([import('./aterm_wasm.js'), loadAtermFontBytes()])
  registerAtermCpuGlue(glue)
  const initOutput = await glue.default({ module_or_path: wasmUrl })
  return { AtermTerminal: glue.AtermTerminal, fontBytes, memory: initOutput.memory }
}

export async function loadAterm(): Promise<LoadedAterm> {
  loadPromise ??= loadAtermOnce()
  return loadPromise
}
