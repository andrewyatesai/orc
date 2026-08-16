// TS dispatch for the tab-title-resolution parity module. The shared TS impl
// was DELETED (`src/shared/tab-title-resolution.ts` keeps only the two parts
// types and the vault-title shape) — every surface now reaches
// `orca_core::tab_title_resolution` through `src/shared/tab-title-ladder.ts` on
// the orca-dispatch seam.
//
// Like the wsl-paths, worktree-id, stable-pane-id and branch-name-from-work
// adapters, this drives the SHIM rather than the wasm oracle, and the harness
// keeps a real TS-vs-Rust differential instead of degenerating to
// wasm-vs-binary: config/vitest.parity.config.ts installs no setup file, so the
// seam is unbound here and the shim answers from its `parity` fallback — which
// is exactly the deleted body, and exactly the code every renderer caller runs
// before (or without) a wasm binding.

import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../src/shared/tab-title-ladder'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'resolveTerminalTabTitle': {
      const { tab, generatedTitlesEnabled, fallback } = input as {
        tab: Parameters<typeof resolveTerminalTabTitle>[0]
        generatedTitlesEnabled: boolean
        fallback?: string
      }
      return resolveTerminalTabTitle(tab, generatedTitlesEnabled, fallback)
    }
    case 'resolveUnifiedTabLabel': {
      const { tab, generatedTitlesEnabled, fallback } = input as {
        tab: Parameters<typeof resolveUnifiedTabLabel>[0]
        generatedTitlesEnabled: boolean
        fallback?: string
      }
      return resolveUnifiedTabLabel(tab, generatedTitlesEnabled, fallback)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
