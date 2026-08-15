// The renderer's line-stats computation, driven by the orca-git Rust core
// compiled to wasm (rust/orca-git-wasm) — the same module the SSH relay embeds
// and the same `line_count.rs` the main process runs via napi. The renderer has
// no napi access (sandbox: true), so it loads the wasm via vite's `?url` asset
// + async init exactly like the aterm engine (no sync-compile on the Chromium
// main thread, no base64 bundle bloat).
import initGitWasm, {
  computeLineStats as wasmComputeLineStats,
  initSync,
  orcaDispatch as wasmOrcaDispatch
} from './orca_git_wasm.js'
import wasmUrl from './orca_git_wasm_bg.wasm?url'
import { setOrcaDispatchBinding } from '../../../../shared/orca-dispatch-seam'
import {
  isGitWasmReady as isGitWasmCoreReady,
  markGitWasmReady,
  markGitWasmUnavailable
} from './git-wasm-availability'

export type DiffLineStats = { added: number; removed: number }

let startPromise: Promise<void> | null = null

// Readiness state and its listeners live in the dependency-free availability
// leaf; re-exported here because ~35 shims already import them from this module.
export {
  isGitWasmReady,
  subscribeGitWasmAvailability as subscribeGitWasmReady
} from './git-wasm-availability'

function markReady(): void {
  // Bind the shared dispatch seam BEFORE flipping availability, so a ready
  // listener that immediately dispatches cannot observe an unbound seam. Before
  // this, tryOrcaDispatch returns null and shared callers use their safe
  // fallback. Fires in production (startGitWasm) and tests
  // (initGitWasmForTestFromBytes).
  setOrcaDispatchBinding((module, fn, inputJson) => wasmOrcaDispatch(module, fn, inputJson))
  markGitWasmReady()
}

/** Kick off the async wasm init (idempotent). Called once from the renderer
 *  bootstrap so the module is compiled long before any diff section renders.
 *
 *  Deliberately NOT retryable: the memoized promise keeps a rejection forever.
 *  wasm-bindgen's module-level state is not re-entrant after a partial init, and
 *  the dominant failures here (a CompileError, a mis-served asset, a CSP that
 *  forbids wasm) are permanent for the session — a retry would re-download 1.4 MB
 *  to fail identically. The fix for the invisible failure is the terminal
 *  `unavailable` state below, not a retry; recovery is a relaunch. */
export function startGitWasm(): Promise<void> {
  if (!startPromise) {
    startPromise = initGitWasm({ module_or_path: wasmUrl }).then(markReady, (error: unknown) => {
      markGitWasmUnavailable(error)
      throw error
    })
    // Why: main.tsx and web/main.tsx fire this as `void startGitWasm()`; without a
    // handler attached at creation the memoized rejection is reported as an
    // unhandledrejection long before the startup gate gets round to awaiting it.
    void startPromise.catch(() => undefined)
  }
  return startPromise
}

/** Test-only synchronous init from raw wasm bytes: vitest runs under Node,
 *  which has no main-thread sync-compile restriction. */
export function initGitWasmForTestFromBytes(bytes: Uint8Array): void {
  initSync({ module: bytes })
  markReady()
}

/**
 * Compute approximate added/removed line counts for a diff section (multiset
 * line matching in Rust). Returns null while the wasm is still initialising —
 * consumers fall back to the numstat-derived section counts and recompute via
 * `subscribeGitWasmReady` — and null for the >500k-char large-input guard
 * (splitting that in a React render would block the UI).
 */
export function computeLineStats(
  original: string,
  modified: string,
  status: string
): DiffLineStats | null {
  if (!isGitWasmCoreReady()) {
    return null
  }
  const json = wasmComputeLineStats(original, modified, status)
  return json === undefined ? null : (JSON.parse(json) as DiffLineStats)
}
