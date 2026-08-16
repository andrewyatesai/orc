// Tree-agnostic cross-platform path resolution, driven by the Rust
// `orca_core::cross_platform_path` core: what a path string MEANS on a possibly
// foreign host — its comparison key, its basename, whether it is absolute, where
// it resolves to, whether it sits inside a root, and its suffix relative to one.
//
// It lives on `orca-dispatch-seam` rather than in one tree's binding directory
// because paths are resolved on EVERY surface: main + cli (napi), the SSH relay
// (wasm via initSync), the renderer (wasm at ready), the web preload
// compatibility layer, the Playwright specs, and the Expo mobile client — which
// bundles no napi and no wasm at all, so its seam is NEVER bound.
//
// `isWindowsAbsolutePathLike` is deliberately NOT cut over and keeps its real
// body in the twin. `renderer/lib/git-wasm/setup-runner-command-platform.ts`
// builds its own pre-ready fallback out of it, and a fallback that itself
// dispatches is not a fallback; the fallback below needs it for the same reason.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED.
//
// Why no sentinel is available. Every return type here is already total: a
// `boolean`, a `string`, or `string | null` where `null` is the twin's REAL
// answer for "not contained". There is no spare state a caller could branch on
// (ported-modules.md, "Signal at the level that has a spare state"), and lifting
// to a list does not help — each call decides ONE path. A sentinel folded back
// with `?? false` / `?? ''` would be the batch-4 defect verbatim.
//
// Why a wrong answer is not survivable. Containment decides which worktree owns
// a file, so a wrong `isPathInsideOrEqual` misroutes it to another workspace;
// the same predicate gates DESTRUCTIVE work (`ai-vault/session-delete.ts`,
// `worktree-removal-safety.ts`, `relay-watcher-removal-fence.ts`) and authorizes
// filesystem access (`ipc/filesystem-auth.ts`), where a wrong `true` reaches
// outside the root. `normalizeRuntimePathForComparison` keys maps and is
// persisted; `relativePathInsideRoot` suffixes are rejoined and handed to the
// filesystem. And on mobile the pre-ready value is the ONLY value there will
// ever be.
//
// So each fallback rebuilds the deleted twin's body verbatim, which makes
// pre-ready equal ready for every input — the same shape `worktree-id-parsing`
// and `terminal-tab-id-validity` use, for the same reason.
//
// Measured, not asserted. 1,833,811 dispatched comparisons of this fallback
// against the napi core agreed on every one: all 14,361 code points whose NFC,
// NFD or lowercase form differs from themselves (the entire risk surface of the
// core's hand-generated NFC tables and of `str::to_lowercase` vs JS
// `toLowerCase`), each planted in a POSIX, a drive and a WSL-UNC path; 12×16×16
// base+mark+mark sequences for canonical ordering and multi-mark composition;
// every 4-atom string over `[/ \ . a C: "" .. é U+212A wsl$ wsl.localhost]`
// (10,513 of them) singly and paired against 20 curated roots in both
// directions; and 45 realistic macOS/Windows/WSL/UNC shapes cross-producted.
// `pnpm parity` re-checks the same claim on every run — the adapter in
// `tools/parity/dispatch/cross-platform-path.ts` drives THIS module with the
// seam unbound, so all 105 corpus vectors compare the fallback against Rust.
//
// `createNormalizedPathInsideOrEqualMatcher` is COMPOSED here rather than
// dispatched, and that is deliberate twice over: orca-dispatch has no arm for it
// (it returns a closure, which cannot cross a JSON boundary), and its whole
// purpose is to normalize the root ONCE for a fan-out. It therefore dispatches
// the root fold and keeps the boundary comparison in TS, so a watcher storm
// crosses the seam once per fan-out instead of once per candidate.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { isOrcaDispatchReady, tryOrcaDispatch } from './orca-dispatch-seam'
import { isWindowsAbsolutePathLike } from './cross-platform-path'

const MODULE = 'cross-platform-path'
const SLASH_CHAR_CODE = '/'.charCodeAt(0)

/**
 * Dispatch to the core, or answer with the twin's body.
 *
 * `isOrcaDispatchReady` rather than a `null` from `tryOrcaDispatch`, because
 * `relativePathInsideRoot` returns a real `null` for "not contained" — collapsing
 * the two would recompute the fallback on the commonest watcher answer.
 */
function dispatchPath<T>(fn: string, input: object, fallback: () => T, root: string): T {
  if (!isOrcaDispatchReady()) {
    return fallback()
  }
  try {
    return tryOrcaDispatch(MODULE, fn, input, { root }) as T
  } catch (error) {
    // Why the catch: a Windows or macOS directory name can hold an unpaired
    // UTF-16 surrogate, so a real path can too. The codec refuses it (it is not
    // valid UTF-8 and cannot cross into Rust at all) and the twin answered it
    // without crossing anything, so the fallback is that same answer. Only the
    // encode rejection is caught; a DispatchCoreError still propagates.
    if (error instanceof DispatchPayloadError) {
      return fallback()
    }
    throw error
  }
}

export function normalizeRuntimePathSeparators(value: string): string {
  return dispatchPath(
    'normalizeRuntimePathSeparators',
    { value },
    () => legacyNormalizeRuntimePathSeparators(value),
    'path'
  )
}

/**
 * Comparison key only — never return this as, or splice it into, a real path.
 *
 * Why NFC: macOS file pickers and on-disk names yield NFD, while agents such as
 * Claude Code record cwd and encode their project directory names in NFC. Both
 * spell the same file, so a non-ASCII workspace otherwise never matches its own
 * sessions (#10832). Folding here knowingly treats canonically equivalent names
 * as one, which is exact on APFS but permissive on byte-exact Linux/SSH hosts —
 * an acceptable trade, since only comparison keys are affected.
 */
export function normalizeRuntimePathForComparison(rawValue: string): string {
  return dispatchPath(
    'normalizeRuntimePathForComparison',
    { value: rawValue },
    () => legacyNormalizeRuntimePathForComparison(rawValue),
    'path'
  )
}

export function isRuntimePathAbsolute(value: string, pathFlavor?: 'posix' | 'windows'): boolean {
  // Why built conditionally: the codec REJECTS an explicitly-undefined property,
  // and an absent `pathFlavor` is what tells the core to auto-detect (the twin's
  // default parameter).
  const input = pathFlavor === undefined ? { value } : { value, pathFlavor }
  return dispatchPath(
    'isRuntimePathAbsolute',
    input,
    () => legacyIsRuntimePathAbsolute(value, pathFlavor),
    'path'
  )
}

export function resolveRuntimePath(basePath: string, targetPath: string): string {
  return dispatchPath(
    'resolveRuntimePath',
    { basePath, targetPath },
    () => legacyResolveRuntimePath(basePath, targetPath),
    'paths'
  )
}

export function getRuntimePathBasename(value: string): string {
  return dispatchPath(
    'getRuntimePathBasename',
    { value },
    () => legacyGetRuntimePathBasename(value),
    'path'
  )
}

/**
 * Pre-normalizes the root so a fan-out normalizes it once, not once per candidate.
 *
 * Why the name says "normalized": candidates must already be run through
 * `normalizeRuntimePathForComparison`. That function is not idempotent for WSL UNC
 * paths (`//wsl.localhost/Ubuntu/A` folds to `//wsl/ubuntu/A`, which a second pass
 * lowercases further), so a raw candidate here would silently fail to match.
 */
export function createNormalizedPathInsideOrEqualMatcher(
  rootPath: string
): (normalizedCandidate: string) => boolean {
  const root = normalizeRuntimePathForComparison(rootPath)
  const rootWithBoundary = comparisonRootBoundary(root)
  return (normalizedCandidate) =>
    normalizedCandidate === root || normalizedCandidate.startsWith(rootWithBoundary)
}

export function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  return dispatchPath(
    'isPathInsideOrEqual',
    { rootPath, candidatePath },
    () => legacyIsPathInsideOrEqual(rootPath, candidatePath),
    'paths'
  )
}

export function relativePathInsideRoot(rootPath: string, candidatePath: string): string | null {
  return dispatchPath(
    'relativePathInsideRoot',
    { rootPath, candidatePath },
    () => legacyRelativePathInsideRoot(rootPath, candidatePath),
    'paths'
  )
}

/** A root's containment prefix: `/` and `X:/` are their own boundary. */
function comparisonRootBoundary(root: string): string {
  return root === '/' || /^[a-z]:\/$/i.test(root) ? root : `${root.replace(/\/+$/, '')}/`
}

function legacyNormalizeRuntimePathSeparators(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return `//${normalized.replace(/^\/+/, '')}`
  }
  return normalized
}

function legacyNormalizeRuntimePathForComparison(rawValue: string): string {
  // Normalize before any folding so the WSL alias branch below is covered too.
  const value = rawValue.normalize('NFC')
  const isWindowsPath = isWindowsAbsolutePathLike(value)
  // Why: backslash is a valid POSIX filename character; fold it only when the
  // path itself proves Windows drive/UNC semantics.
  const normalized = trimRuntimePathTrailingSlash(
    isWindowsPath ? legacyNormalizeRuntimePathSeparators(value) : value.replace(/\/+/g, '/')
  )
  const wslUnc = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i)
  if (wslUnc) {
    // Why: Windows exposes the same case-sensitive WSL filesystem through two
    // UNC aliases, while the distro/server portion remains case-insensitive.
    return `//wsl/${wslUnc[1].toLowerCase()}${wslUnc[2] ?? ''}`
  }
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

function legacyIsRuntimePathAbsolute(value: string, pathFlavor?: 'posix' | 'windows'): boolean {
  const flavor = pathFlavor ?? (isWindowsPathFlavor(value) ? 'windows' : 'posix')
  if (flavor === 'windows') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\') || value.startsWith('/')
  }
  return value.startsWith('/')
}

function legacyResolveRuntimePath(basePath: string, targetPath: string): string {
  const pathFlavor =
    isWindowsPathFlavor(basePath) || isWindowsPathFlavor(targetPath) ? 'windows' : 'posix'
  if (legacyIsRuntimePathAbsolute(targetPath, pathFlavor)) {
    return normalizeRuntimePathDots(targetPath, pathFlavor)
  }
  return normalizeRuntimePathDots(
    `${trimRuntimePathTrailingSlash(legacyNormalizeRuntimePathSeparators(basePath))}/${targetPath}`,
    pathFlavor
  )
}

function legacyGetRuntimePathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/g, '')
  if (!trimmed) {
    return ''
  }
  return trimmed.split(/[\\/]/).findLast(Boolean) ?? ''
}

function legacyIsPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const root = legacyNormalizeRuntimePathForComparison(rootPath)
  const candidate = legacyNormalizeRuntimePathForComparison(candidatePath)
  return candidate === root || candidate.startsWith(comparisonRootBoundary(root))
}

function legacyRelativePathInsideRoot(rootPath: string, candidatePath: string): string | null {
  // Why: decide Windows-ness on the same NFC form the comparison key uses, or the
  // two disagree (U+212A folds to 'K', making only one side a drive path) and the
  // segment counts desync. Only the branch test sees NFC — the sliced string stays
  // raw so the returned suffix remains byte-exact.
  const normalizedCandidate = trimRuntimePathTrailingSlash(
    isWindowsAbsolutePathLike(candidatePath.normalize('NFC'))
      ? legacyNormalizeRuntimePathSeparators(candidatePath)
      : candidatePath.replace(/\/+/g, '/')
  )
  const comparisonRoot = legacyNormalizeRuntimePathForComparison(rootPath)
  const comparisonCandidate = legacyNormalizeRuntimePathForComparison(candidatePath)

  if (comparisonCandidate === comparisonRoot) {
    return ''
  }
  const isRoot = comparisonRoot === '/' || /^[a-z]:\/$/i.test(comparisonRoot)
  const comparisonPrefix = isRoot ? comparisonRoot : `${comparisonRoot}/`
  if (!comparisonCandidate.startsWith(comparisonPrefix)) {
    return null
  }
  return sliceCandidatePastRootSegments(comparisonRoot, normalizedCandidate)
}

/**
 * Why: skip whole root segments rather than a character count. Comparison
 * folding (NFC, case, UNC alias) changes length, so a folded-prefix length would
 * cut the raw candidate mid-character and fabricate a path; segment positions
 * survive every fold and keep the suffix byte-exact. Scanning rather than
 * splitting keeps watcher event storms allocation-free.
 */
function sliceCandidatePastRootSegments(root: string, candidate: string): string {
  let remainingRootSegments = 0
  let inRootSegment = false
  for (let index = 0; index < root.length; index++) {
    if (root.charCodeAt(index) === SLASH_CHAR_CODE) {
      inRootSegment = false
    } else if (!inRootSegment) {
      inRootSegment = true
      remainingRootSegments++
    }
  }

  let inSegment = false
  for (let index = 0; index < candidate.length; index++) {
    if (candidate.charCodeAt(index) === SLASH_CHAR_CODE) {
      inSegment = false
      continue
    }
    if (!inSegment) {
      inSegment = true
      if (remainingRootSegments-- === 0) {
        return candidate.slice(index)
      }
    }
  }
  return ''
}

function trimRuntimePathTrailingSlash(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value
  }
  return value.replace(/\/+$/, '')
}

function isWindowsPathFlavor(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') || value.startsWith('//')
}

function normalizeRuntimePathDots(value: string, pathFlavor: 'posix' | 'windows'): string {
  const normalized = legacyNormalizeRuntimePathSeparators(value)
  const { root, rest } = splitRuntimePathRoot(normalized, pathFlavor)
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!root) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }
  const suffix = segments.join('/')
  if (!root) {
    return suffix || '.'
  }
  return suffix ? `${root}${suffix}` : trimRuntimePathTrailingSlash(root)
}

function splitRuntimePathRoot(
  value: string,
  pathFlavor: 'posix' | 'windows'
): { root: string; rest: string } {
  if (pathFlavor === 'windows') {
    const drive = value.match(/^([A-Za-z]:)(?:\/|$)/)
    if (drive) {
      return { root: `${drive[1]}/`, rest: value.slice(drive[0].length) }
    }
    if (value.startsWith('//')) {
      const parts = value.slice(2).split('/')
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const root = `//${parts[0]}/${parts[1]}/`
        return { root, rest: parts.slice(2).join('/') }
      }
      return { root: '//', rest: value.slice(2) }
    }
    if (value.startsWith('/')) {
      return { root: '/', rest: value.slice(1) }
    }
  }
  if (value.startsWith('/')) {
    return { root: '/', rest: value.slice(1) }
  }
  return { root: '', rest: value }
}
