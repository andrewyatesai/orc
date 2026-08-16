/**
 * Shared, pure Quick Open (Cmd/Ctrl+P) file-listing filter policy used by both the local main
 * process and the SSH relay. No IO, Electron, WSL, or auth — callers own process execution and
 * transport-specific path translation.
 *
 * Centralized to stop local/relay listFiles from drifting on blocklist, ignores, exclusions,
 * timeouts, and buffering. See docs/design/share-quick-open-file-listing.md.
 */
import { posix, win32 } from 'node:path'

// The three scanner-argument builders are CUT OVER to the Rust
// `orca_core::quick_open_filter` core and now ship from
// `quick-open-listing-arguments.ts` on the dispatch seam. This file keeps the
// blocklist data both halves read, the shared types, and four bodies that must
// NOT cross, each for a measured reason:
//
//   - buildExcludePathPrefixes. `node:path`'s `relative()` resolves its operands
//     against `process.cwd()` and folds Windows UNC roots case-insensitively;
//     the zero-dep Rust port reproduces neither (`orca_core`'s `path_flavor` has
//     no `//` UNC branch at all). 864 comparisons against both shipped
//     artifacts, 42 disagreements — including
//     buildExcludePathPrefixes('//Server/Share/Repo',
//     ['//server/share/repo/packages/app']), which is `['packages/app']` here
//     and `[]` in Rust, i.e. a nested worktree that stops being excluded. That
//     input is what `quick-open-file-list.ts` builds for a UNC workspace, and it
//     is asserted in this module's own test; the parity corpus has no `//` root,
//     which is why `pnpm parity` is green over it.
//   - shouldIncludeQuickOpenPath / shouldExcludeQuickOpenRelPath /
//     normalizeQuickOpenRgLine. All three run ONCE PER LISTED FILE (and per
//     directory entry in `quick-open-readdir-walk.ts`), and
//     `orca-runtime-files.ts` lists with no maxResults. Measured through the
//     real codec: 265ns here against 929ns dispatched, so the three together
//     cost ~2ms per 1,000 files — ~1s added to an uncapped $HOME scan, on the
//     path whose 10s-timeout bug this blocklist exists for. They are clean
//     against both artifacts (0 divergences in 101,348 comparisons); what
//     unblocks them is a BATCHED dispatch arm that crosses once per rg chunk
//     instead of once per line, which needs a Rust change and an artifact
//     rebuild.

// ─── Hidden-dir blocklist ────────────────────────────────────────────

// Blocklist (not allowlist) keeps novel dotfiles discoverable; entries here are tool-generated
// caches/state, never hand-edited. Do NOT add user-authored dotdirs (.config, .ssh, .github) — users open files there.
export const HIDDEN_DIR_BLOCKLIST: ReadonlySet<string> = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.stably',
  '.vscode',
  '.idea',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.docker',
  '.husky',
  // Home-dir cache/install/runtime state; caused the original $HOME-root 10s-timeout bug.
  '.npm',
  '.npm-global',
  '.gvfs'
])

// `.local` may hold user files; block only the generated `.local/share` runtime subtree.
// Exported as data because `quick-open-listing-arguments.ts` builds its pre-ready
// globs from the same three tables the segment walk below reads.
export const HIDDEN_PATH_BLOCKLIST: readonly string[] = ['.local/share']

// Separate from HIDDEN_DIR_BLOCKLIST: node_modules isn't a dotdir but must still be pruned.
export const NON_DOTTED_PRUNE = 'node_modules'

function containsBlockedRelPath(path: string, blockedPath: string): boolean {
  return (
    path === blockedPath ||
    path.startsWith(`${blockedPath}/`) ||
    path.endsWith(`/${blockedPath}`) ||
    path.includes(`/${blockedPath}/`)
  )
}

/**
 * Returns true if `path` (`/`-separated, root-relative) traverses no blocklisted segment.
 * Correctness backstop after the rg/git pruning globs, in case a blocked dir slips through.
 * Walks segment-by-segment (no split allocation) since it runs once per file on ~100k-file repos.
 */
export function shouldIncludeQuickOpenPath(path: string): boolean {
  for (const blockedPath of HIDDEN_PATH_BLOCKLIST) {
    if (containsBlockedRelPath(path, blockedPath)) {
      return false
    }
  }
  let start = 0
  const len = path.length
  while (start < len) {
    let end = path.indexOf('/', start)
    if (end === -1) {
      end = len
    }
    const segment = path.substring(start, end)
    if (segment === NON_DOTTED_PRUNE || HIDDEN_DIR_BLOCKLIST.has(segment)) {
      return false
    }
    start = end + 1
  }
  return true
}

// ─── Path flavor detection ───────────────────────────────────────────

// Why: local-OS path.relative is wrong for remote roots (app OS vs relay OS); pick win32 vs posix by root shape.
function pathFlavor(rootPath: string): typeof posix | typeof win32 {
  // Drive letter like C:\ or C:/
  if (/^[a-zA-Z]:[\\/]/.test(rootPath)) {
    return win32
  }
  // UNC \\server\share or //server/share
  if (rootPath.startsWith('\\\\') || rootPath.startsWith('//')) {
    return win32
  }
  return posix
}

// ─── Exclude-path normalization ──────────────────────────────────────

/**
 * Normalize `excludePaths` (renderer-sent absolute paths for nested worktrees) into `/`-separated,
 * root-relative prefixes. Malformed/outside-root/root-equal values are silently dropped so a stale
 * or typo'd exclude path can't fail the request.
 */
export function buildExcludePathPrefixes(rootPath: string, excludePaths?: unknown): string[] {
  if (!Array.isArray(excludePaths)) {
    return []
  }
  const flavor = pathFlavor(rootPath)
  // Trim trailing separators so comparison is stable.
  const trimmedRoot = rootPath.replace(/[\\/]+$/, '')
  const normalizedRoot = `${trimmedRoot.replace(/\\/g, '/')}/`
  const out: string[] = []
  for (const raw of excludePaths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      continue
    }
    // Fast path: input already under the root with the same separator shape.
    const rawFwd = raw.replace(/\\/g, '/')
    let rel: string
    if (rawFwd === normalizedRoot.slice(0, -1)) {
      // Root-equal — refuse to exclude the whole tree.
      continue
    }
    rel = rawFwd.startsWith(normalizedRoot)
      ? rawFwd.slice(normalizedRoot.length)
      : // Fall back to path-flavor relative so remote paths don't get local-OS semantics.
        flavor.relative(trimmedRoot, raw).replace(/\\/g, '/')
    if (!rel || isParentRelativePath(rel) || rel.startsWith('/')) {
      continue
    }
    // Strip any trailing slash so boundary checks are unambiguous.
    rel = rel.replace(/\/+$/, '')
    if (rel.length === 0) {
      continue
    }
    out.push(rel)
  }
  return out
}

/**
 * Segment-boundary exclude check (`relPath` is `/`-separated, root-relative).
 * Why segment boundary: a raw `startsWith` would match `packages/app2` against exclusion `packages/app`.
 */
export function shouldExcludeQuickOpenRelPath(
  relPath: string,
  excludePathPrefixes: readonly string[]
): boolean {
  for (const prefix of excludePathPrefixes) {
    if (relPath === prefix) {
      return true
    }
    if (relPath.length > prefix.length && relPath.startsWith(`${prefix}/`)) {
      return true
    }
  }
  return false
}

function isParentRelativePath(relPath: string): boolean {
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  return relPath === '..' || relPath.startsWith('../')
}

// ─── rg arg shapes (builders live in quick-open-listing-arguments.ts) ─

export type RgArgsOptions = {
  /** rg positional search target: absolute root (strip prefix from output) or `.` (cwd-relative); both need cwd: rootPath. */
  searchRoot: string
  /** Root-relative, `/`-separated prefixes (from buildExcludePathPrefixes). */
  excludePathPrefixes: readonly string[]
  /** On Windows rg emits `\\`-separated paths; pass true to force `/` output. */
  forceSlashSeparator: boolean
}

export type RgArgs = {
  /** Main pass: all non-ignored files, hidden dotfiles included. */
  primary: string[]
  /** Second pass: ignored files, hidden dotfiles included. */
  ignoredPass: string[]
}

// ─── rg stdout line normalization ────────────────────────────────────

export type RgOutputMode =
  /** rg was invoked with an absolute search target; output paths are absolute. */
  | { kind: 'absolute'; rootPath: string }
  /** rg invoked with cwd: rootPath and searchRoot '.'; output is cwd-relative, usually `./`-prefixed. */
  | { kind: 'cwd-relative' }

/**
 * Convert one rg --files stdout line into a root-relative, `/`-separated path.
 * Returns `null` for lines that escape the root (symlink edge cases) or can't be normalized.
 * Callers do any WSL translation first, keeping WSL out of the shared module.
 */
export function normalizeQuickOpenRgLine(rawLine: string, outputMode: RgOutputMode): string | null {
  let line = rawLine
  // Strip CR so CRLF from rg on Windows doesn't leak into results.
  if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
    line = line.substring(0, line.length - 1)
  }
  if (!line) {
    return null
  }
  const normalized = line.replace(/\\/g, '/')
  if (outputMode.kind === 'cwd-relative') {
    let rel = normalized
    if (rel.startsWith('./')) {
      rel = rel.slice(2)
    } else if (rel === '.') {
      return null
    }
    if (!rel || rel.startsWith('/') || isParentRelativePath(rel)) {
      return null
    }
    return rel
  }
  // Absolute mode: strip the root prefix.
  // Why: only replace backslashes; collapsing repeated slashes would break Windows UNC roots (`\\server\share`).
  const normalizedRoot = `${outputMode.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  if (normalized.startsWith(normalizedRoot)) {
    const rel = normalized.substring(normalizedRoot.length)
    if (!rel || isParentRelativePath(rel) || rel.startsWith('/')) {
      return null
    }
    return rel
  }
  return null
}

// ─── git ls-files arg shape (builder lives in quick-open-listing-arguments.ts) ─

export type GitLsFilesArgs = {
  primary: string[]
  ignoredPass: string[]
}
