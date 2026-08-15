// TS dispatch for the wsl-paths parity module. The shared TS impl was DELETED
// (`src/shared/wsl-paths.ts` keeps only the `WslUncPathInfo` type and the
// `WSL_UNC_PATH_PATTERN` data) — every surface now reaches
// `orca_core::wsl_paths` through `src/shared/wsl-unc-paths.ts` on the
// orca-dispatch seam.
//
// Like the worktree-id adapter, this drives the SHIM rather than the wasm
// oracle, and the harness keeps a real TS-vs-Rust differential instead of
// degenerating to wasm-vs-binary: config/vitest.parity.config.ts installs no
// setup file, so the seam is unbound here and the shim answers from its
// `parity` fallback — which is exactly the deleted body, and exactly the code
// the renderer/mobile/Playwright surfaces run before (or without) a binding.
import { isWslUncPath, parseWslUncPath } from '../../../src/shared/wsl-unc-paths'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'parseWslUncPath':
      return parseWslUncPath(input as string)
    case 'isWslUncPath':
      return isWslUncPath(input as string)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
