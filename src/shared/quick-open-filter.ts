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
// blocklist data both halves read, the shared types, and FOUR bodies that stay
// in TypeScript.
//
// They stay for TWO DIFFERENT reasons, and the reasons are anti-correlated,
// which is the finding rather than an accident of ordering: the only PER-SCAN
// export cannot cross (semantics), and the only exports that could cross are
// PER-FILE (cost). Nothing in this module is both crossable and affordable at
// the per-call seam, so it crosses as a unit or not at all — and its per-scan
// half already crossed, as the three builders next door.
//
// Re-derived 2026-08-16 from scratch rather than inherited, against BOTH shipped
// artifacts (`orca_node.node` and `orca_git_wasm_bg.wasm`), which agreed with
// each other on every input. `config/scripts/quick-open-filter-crossing-cost.mjs`
// owns the cost half and the both-artifacts half and FAILS with `--check` when
// either refusal goes stale; `quick-open-filter-crossing.test.ts` owns the
// correctness half and every claim below that can go red.
//
//   - buildExcludePathPrefixes. Its answer becomes `--glob !<prefix>` and
//     `:(exclude,glob)<prefix>`, i.e. argv of a spawned rg / git ls-files, and it
//     also keys `fs-handler.ts`'s scan-coalescing cache — so a wrong answer does
//     not render wrong, it RUNS, and a second request then dedupes onto it.
//     4,312 comparisons over a 28-root x 75-exclude-path grid: 400
//     disagreements, in THREE independent classes.
//       1. `orca_core::path_flavor` has no `//` branch (it tests `\\` only), so
//          it reads a UNC root as POSIX and compares case-sensitively (86).
//          buildExcludePathPrefixes('//Server/Share/Repo',
//          ['//server/share/repo/packages/app']) is `['packages/app']` here and
//          `[]` in Rust — a nested worktree that stops being excluded, on the
//          root shape a UNC workspace produces.
//       2. `node:path`'s `relative()` resolves BOTH operands against
//          `process.cwd()` (216). That one is a PROOF, not a port gap: the twin
//          is not a pure function of its arguments — its answer depends on the
//          host's working directory and, under win32, its current drive — so no
//          pure core can reproduce it, however carefully ported.
//       3. `win32.relative()` folds the whole path with full-Unicode
//          `toLowerCase`; the port uses `eq_ignore_ascii_case` (98). A Windows
//          workspace named in Cyrillic, accented or Turkish-dotted text stops
//          matching and its exclude pathspec silently vanishes. Same class: a
//          cross-drive `relative()` answers with the RESOLVED to-path in Node
//          (`D:/repo/b`) and an unnormalised one in Rust (`D:/repo/a/../b`).
//     Classes 2 and 3 defeat the obvious "cross only absolute, non-`//` roots"
//     gate — every one of 5 targeted attacks passes that gate and still diverges
//     — so this is not a shim contract to write. Classes 1 and 3 are a port gap
//     plus an artifact rebuild; class 2 would need cwd carried across the seam,
//     which is a different function, not this one. `pnpm parity`'s corpus has no
//     `//` root and no non-ASCII Windows path, which is why it is green over all
//     of it; the disagreement rows in the crossing suite are what pin it.
//   - shouldIncludeQuickOpenPath / shouldExcludeQuickOpenRelPath /
//     normalizeQuickOpenRgLine. Held back on COST, and the cost is
//     ARCHITECTURAL rather than an implementation detail to optimise away.
//     Correctness is not the blocker: the named shape cross-product is 1,281
//     inputs, which against both artifacts is 2,478 comparisons after the 84 the
//     codec refuses for a lone surrogate, and they agree on everything except one
//     out-of-type `RgOutputMode` cell. The corpus is discriminating — all three
//     seeded idiom substitutions redden it. But the FLOOR of ONE crossing
//     — the entry called with the payload already built and the answer left
//     unparsed — is 381 ns through napi and 725 ns through wasm, which already
//     exceeds the ENTIRE body of two of the three. Through the real codec the
//     three cost 309 ns here against 2,062 ns napi (6.7x) and 3,601 ns wasm
//     (11.6x). They run ONCE PER LISTED FILE (and per directory entry in
//     `quick-open-readdir-walk.ts`), and `orca-runtime-files.ts` lists with no
//     maxResults: a real $HOME with these very globs applied emits 1,568,458
//     lines in 7.7s of rg — most of the hard 10s per-pass timeout this blocklist
//     exists to avoid — so cutting them over adds +2.6s (napi) to +4.9s (wasm)
//     of blocking main-thread JS per pass, and the two passes share that thread.
//     The general form, worth reusing on the next module: a per-item predicate
//     whose body costs less than the ~400 ns seam floor cannot profitably cross
//     it, which is the same reason `cross-platform-path-resolution.ts` composes
//     `createNormalizedPathInsideOrEqualMatcher` instead of dispatching it. What
//     unblocks these three is a BATCHED arm that crosses once per rg chunk
//     instead of once per line — a Rust change plus an artifact rebuild. The
//     crossing suite watches for that arm and goes red the day it lands.
//
// Cutting the three over would also move no counter: `report-rust-orphan-ports.mjs`
// already lists `quick-open-filter` as having production dispatch, through
// `quick-open-listing-arguments.ts:106`.

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
