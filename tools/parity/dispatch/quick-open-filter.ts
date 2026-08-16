// TS dispatch for the quick-open-filter parity module. The three scanner-argument
// builders are cut over to `orca_core::quick_open_filter`; their TS bodies live in
// `src/shared/quick-open-listing-arguments.ts` as that shim's `parity` fallback.
//
// Like the branch-name-from-work, wsl-paths, worktree-id and stable-pane-id
// adapters, this drives the SHIM rather than the wasm oracle, so the harness keeps
// a real TS-vs-Rust differential instead of degenerating to wasm-vs-binary:
// config/vitest.parity.config.ts installs no setup file, so the seam is unbound
// here and the shim answers from that fallback — which is exactly the deleted body,
// and exactly the code main and the relay run before (or without) a binding.
// buildGitLsFilesArgsForQuickOpen used to go through the oracle for want of such a
// fallback; it no longer has to.
//
// The four remaining functions are still live TS (still the production impl),
// compared against Rust for real parity — including buildExcludePathPrefixes, which
// leans on node:path's cwd-resolving, case-insensitive win32/UNC relative()
// semantics the zero-dep Rust port cannot reproduce (see the twin's header).
import {
  buildExcludePathPrefixes,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath,
  type RgOutputMode
} from '../../../src/shared/quick-open-filter'
import {
  buildGitLsFilesArgsForQuickOpen,
  buildHiddenDirExcludeGlobs,
  buildRgArgsForQuickOpen,
  type RgArgsOptions
} from '../../../src/shared/quick-open-listing-arguments'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'buildGitLsFilesArgsForQuickOpen': {
      const { excludePathPrefixes } = (input ?? {}) as { excludePathPrefixes?: readonly string[] }
      // The twin's default parameter, not an empty list the caller passed.
      return excludePathPrefixes === undefined
        ? buildGitLsFilesArgsForQuickOpen()
        : buildGitLsFilesArgsForQuickOpen(excludePathPrefixes)
    }
    case 'shouldIncludeQuickOpenPath': {
      const { path } = input as { path: string }
      return shouldIncludeQuickOpenPath(path)
    }
    case 'buildExcludePathPrefixes': {
      const { rootPath, excludePaths } = input as { rootPath: string; excludePaths?: unknown }
      return buildExcludePathPrefixes(rootPath, excludePaths)
    }
    case 'shouldExcludeQuickOpenRelPath': {
      const { relPath, excludePathPrefixes } = input as {
        relPath: string
        excludePathPrefixes: readonly string[]
      }
      return shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)
    }
    case 'buildHiddenDirExcludeGlobs':
      return buildHiddenDirExcludeGlobs()
    case 'buildRgArgsForQuickOpen':
      return buildRgArgsForQuickOpen(input as RgArgsOptions)
    case 'normalizeQuickOpenRgLine': {
      const { rawLine, outputMode } = input as { rawLine: string; outputMode: RgOutputMode }
      return normalizeQuickOpenRgLine(rawLine, outputMode)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
