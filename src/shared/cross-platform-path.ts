// Reduced twin for the `cross_platform_path` cut-over. Everything this module
// used to implement — the comparison key, separator folding, absoluteness,
// resolution, basename and containment — now reaches
// `orca_core::cross_platform_path` through `cross-platform-path-resolution.ts`
// on the orca-dispatch seam. Import from there, not from here.
//
// One predicate stays a real TS implementation, on purpose:
// `renderer/lib/git-wasm/setup-runner-command-platform.ts` rebuilds its own
// pre-ready fallback out of it, and a fallback that itself dispatches is not a
// fallback. `cross-platform-path-resolution.ts` needs it for the same reason, so
// cutting it over would leave both shims with nothing to fall back to. Keeping
// it here also keeps its parity vectors a genuine TS-vs-Rust differential rather
// than a self-comparison.
//
// The two WSL-alias predicates below sit on TOP of the shim (they compose the
// dispatched comparison key), so the import cycle with the resolution module is
// call-time only and safe at module evaluation.

import { normalizeRuntimePathForComparison } from './cross-platform-path-resolution'
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from './wsl-unc-paths'

export function isWindowsAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
}

/**
 * Whether names under `rootPath` compare case-insensitively.
 *
 * Decided by path SYNTAX, never by the client platform — a Windows client can
 * drive a case-sensitive SSH or WSL workspace. Windows drive/UNC roots fold
 * case; the WSL UNC aliases front a case-sensitive Linux filesystem, as do
 * POSIX roots. macOS stays case-sensitive here, matching
 * `normalizeRuntimePathForComparison`: folding a case-sensitive root would
 * merge distinct files, which is worse than missing a case-only duplicate.
 */
export function isCaseInsensitiveRuntimeRoot(rootPath: string): boolean {
  return isWindowsAbsolutePathLike(rootPath) && !isWslUncPath(rootPath)
}

/**
 * Whether two paths are the SAME local-Windows file reached through WSL aliases.
 *
 * Only the case-insensitive WSL surface — the \\wsl$ / \\wsl.localhost share, the
 * distro, and any /mnt/<drive> drvfs tail — is folded here. The Linux path tail
 * stays case-sensitive: `//wsl.localhost/Ubuntu/home/Alice` and
 * `\\wsl.localhost\Ubuntu\home\alice` are DISTINCT files, so this returns false.
 * At least one side must actually be a WSL UNC alias; two plain UNC shares
 * (`//server/share` vs `\\server\share`) are never treated as WSL aliases.
 */
export function areLocalWindowsWslPathAliases(left: string, right: string): boolean {
  const leftWslPath = parseWslUncPath(left)
  const rightWslPath = parseWslUncPath(right)
  if (!leftWslPath && !rightWslPath) {
    return false
  }
  const normalize = (value: string): string => {
    const wslPath = parseWslUncPath(value)
    return normalizeRuntimePathForComparison(
      wslPath ? toWindowsWslPath(wslPath.linuxPath, wslPath.distro) : value
    )
  }
  return normalize(left) === normalize(right)
}
