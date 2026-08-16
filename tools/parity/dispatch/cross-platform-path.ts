// TS dispatch for the cross-platform-path parity module. The shared TS impl was
// DELETED — `src/shared/cross-platform-path.ts` keeps only
// `isWindowsAbsolutePathLike` (the basis of two shims' pre-ready fallbacks) and
// every other surface now reaches `orca_core::cross_platform_path` through
// `src/shared/cross-platform-path-resolution.ts` on the orca-dispatch seam.
//
// Like the worktree-id adapter, this one drives the SHIM rather than the wasm
// oracle, and the harness keeps a real TS-vs-Rust differential instead of
// degenerating to wasm-vs-binary: config/vitest.parity.config.ts installs no
// setup file, so the seam is unbound here and the shim answers from its `parity`
// fallback — which is exactly the deleted body, and exactly the code the mobile
// client (never bound), the Playwright specs and the pre-wasm renderer run. That
// makes every case below a standing re-check of the pre-ready contract.
//
// `isWindowsAbsolutePathLike` still calls the twin, so its cases stay a true
// differential against the core rather than the shim comparing Rust to Rust.

import { isWindowsAbsolutePathLike } from '../../../src/shared/cross-platform-path'
import {
  createNormalizedPathInsideOrEqualMatcher,
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../src/shared/cross-platform-path-resolution'

/** Mirrored verbatim in the Rust arm so a bad vector reads the same on both legs. */
const MATCHER_SHAPE =
  'createNormalizedPathInsideOrEqualMatcher expects { rootPath: string, normalizedCandidate: string }'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'isWindowsAbsolutePathLike': {
      const { value } = input as { value: string }
      return isWindowsAbsolutePathLike(value)
    }
    case 'normalizeRuntimePathSeparators': {
      const { value } = input as { value: string }
      return normalizeRuntimePathSeparators(value)
    }
    case 'normalizeRuntimePathForComparison': {
      const { value } = input as { value: string }
      return normalizeRuntimePathForComparison(value)
    }
    case 'isRuntimePathAbsolute': {
      // pathFlavor is optional: omitted → the shim omits the key and the core
      // auto-detects from value (mirrors the Rust `flavor: None` arm).
      const { value, pathFlavor } = input as {
        value: string
        pathFlavor?: 'posix' | 'windows'
      }
      return pathFlavor === undefined
        ? isRuntimePathAbsolute(value)
        : isRuntimePathAbsolute(value, pathFlavor)
    }
    case 'resolveRuntimePath': {
      const { basePath, targetPath } = input as { basePath: string; targetPath: string }
      return resolveRuntimePath(basePath, targetPath)
    }
    case 'getRuntimePathBasename': {
      const { value } = input as { value: string }
      return getRuntimePathBasename(value)
    }
    case 'isPathInsideOrEqual': {
      const { rootPath, candidatePath } = input as { rootPath: string; candidatePath: string }
      return isPathInsideOrEqual(rootPath, candidatePath)
    }
    case 'relativePathInsideRoot': {
      const { rootPath, candidatePath } = input as { rootPath: string; candidatePath: string }
      return relativePathInsideRoot(rootPath, candidatePath)
    }
    // The export returns a CLOSURE, which cannot cross the dispatch boundary as a
    // value, so the Rust arm answers the predicate the closure APPLIES. The vector
    // therefore carries the candidate too, and this drives the REAL closure with
    // it — a differential on the closure's behaviour, not on a stand-in for it.
    case 'createNormalizedPathInsideOrEqualMatcher': {
      const { rootPath, normalizedCandidate } = (input ?? {}) as {
        rootPath?: unknown
        normalizedCandidate?: unknown
      }
      if (typeof rootPath !== 'string' || typeof normalizedCandidate !== 'string') {
        // The twin would throw a TypeError on `undefined.startsWith`; the shape
        // guard turns that into the same envelope the Rust arm returns.
        return { __parity_error__: MATCHER_SHAPE }
      }
      return createNormalizedPathInsideOrEqualMatcher(rootPath)(normalizedCandidate)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
