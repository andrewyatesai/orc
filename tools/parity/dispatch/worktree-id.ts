// TS dispatch for the worktree-id parity module. The shared TS impl was DELETED
// (`src/shared/worktree-id.ts` keeps only the separator constants, the suffix
// pattern and the `ParsedWorktreeId` type) — every surface now reaches
// `orca_core::worktree_id` through `src/shared/worktree-id-parsing.ts` on the
// orca-dispatch seam.
//
// Unlike the other cut-over adapters, this one drives the SHIM rather than the
// wasm oracle, and the harness keeps a real TS-vs-Rust differential instead of
// degenerating to wasm-vs-binary: config/vitest.parity.config.ts installs no
// setup file, so the seam is unbound here and the shim answers from its
// `parity` fallback — which is exactly the deleted body, and exactly the code
// the renderer/mobile/Playwright surfaces run before (or without) a binding.
//
// `getWorktreePathBasenameFromId` is composed in the shim over the dispatched
// `splitWorktreeIdForFilesystem` rather than dispatched itself, because the core
// trims with Rust's `char::is_whitespace` and the twin trimmed with JS
// `String.prototype.trim` (they differ on U+0085 and U+FEFF). Its cases here
// still compare the production answer against the core, so a vector on either
// code point would correctly fail until the core is re-ported.
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../src/shared/worktree-id-parsing'

export function dispatch(fn: string, input: unknown): unknown {
  const worktreeId = input as string
  switch (fn) {
    case 'getRepoIdFromWorktreeId':
      return getRepoIdFromWorktreeId(worktreeId)
    case 'splitWorktreeId':
      return splitWorktreeId(worktreeId)
    case 'splitWorktreeIdForFilesystem':
      return splitWorktreeIdForFilesystem(worktreeId)
    case 'getWorktreePathBasenameFromId':
      return getWorktreePathBasenameFromId(worktreeId)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
