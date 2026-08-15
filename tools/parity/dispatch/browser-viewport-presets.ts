// TS dispatch for the browser-viewport-presets parity module. The shared TS impl
// was DELETED (`src/shared/browser-viewport-presets.ts` keeps only the types and
// the preset table — the Rust orca-core `browser_viewport_presets` port is the
// sole implementation, reached from the renderer through
// src/renderer/src/lib/git-wasm/browser-viewport-presets.ts), so this adapter
// drives the SAME wasm: the vectors' recorded goldens now pin the production
// surface, and the harness's TS-vs-Rust diff degenerates to wasm-vs-binary.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('browser-viewport-presets', fn, JSON.stringify(input ?? null))
  )
}
