// The three Quick Open scanner-argument builders on the Rust
// `orca_core::quick_open_filter` core. This sits on `orca-dispatch-seam` rather
// than in one tree's binding directory because Quick Open lists files on two
// surfaces with no shared binding: main + cli spawn `rg`/`git ls-files` through
// napi (`ipc/filesystem-list-files.ts`,
// `ipc/filesystem-list-files-git-fallback.ts`) and the SSH relay spawns the same
// two commands through wasm (`fs-handler-list-files.ts`,
// `fs-handler-git-fallback.ts`). It replaces the single `requireOrcaDispatch`
// call `quick-open-filter.ts` used to make for `buildGitLsFilesArgsForQuickOpen`.
//
// PRE-READY CONTRACT — `parity` ×3, and it is FORCED, not chosen. These values
// ARE the argv of a spawned process, so every wrong answer is a wrong file list
// rather than a visible error: a missing `!**/node_modules` glob makes rg
// traverse a 100k-file tree it was meant to prune (the $HOME-root timeout this
// blocklist exists for), and a missing `:(exclude,glob)` pathspec lists a nested
// linked worktree's files as if they were this workspace's. No sentinel has
// anywhere to live either — `[]` and `{primary: [], ignoredPass: []}` are argv
// too, and `rg` with no args reads stdin while `git ls-files` with no args lists
// the whole index, so both "empty" values are commands that RUN. Lifting to a
// list does not help: each answer configures ONE scan. So each fallback below is
// the deleted twin's body, verbatim over the blocklist data the twin keeps.
//
// The result is not persisted, but "visible, not persisted" is not the whole
// hazard: `fs-handler.ts` keys its scan-coalescing cache on the exclude prefixes,
// and `orca-runtime-files.ts` calls `listQuickOpenFiles` with NO maxResults, so a
// wrong arg list is a wrong scan that a second request then dedupes onto.
//
// MEASURED, not assumed: 18,504 fallback-vs-core comparisons against BOTH
// shipped artifacts (9,252 inputs × `orca_git_wasm_bg.wasm` and
// `orca_node.node`) — every exclude-prefix list up to length 2 over a 28-atom
// alphabet of glob metacharacters, UNC and drive roots, astral characters, BOM,
// U+0085, embedded newlines and a 300-char segment, crossed with five
// searchRoots and both separator settings — agree on all of them. The corpus is
// discriminating: dropping the glob-metacharacter escape produces 7,854
// divergences, and dropping the `--no-ignore-vcs` head or the `--` / `.`
// positive pathspec reddens the bound-vs-unbound rows in
// `quick-open-listing-arguments.test.ts`.
//
// TWO DRIFT RISKS, both pinned by that test rather than left to review:
//  1. the hidden-dir blocklist now has two copies — `HIDDEN_DIR_BLOCKLIST` here
//     in TS (which `quick-open-readdir-walk.ts` still walks entry-by-entry) and
//     `orca_core::quick_open_filter`'s table, which the bound path reads. If they
//     drift, rg prunes a directory the readdir fallback descends into. The
//     bound-vs-unbound rows compare the two tables on every run.
//  2. the twin's `shouldIncludeQuickOpenPath` is the backstop for whatever these
//     globs fail to prune, so the two must agree on which names are blocked.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  HIDDEN_DIR_BLOCKLIST,
  HIDDEN_PATH_BLOCKLIST,
  NON_DOTTED_PRUNE,
  type GitLsFilesArgs,
  type RgArgs,
  type RgArgsOptions
} from './quick-open-filter'

export type { GitLsFilesArgs, RgArgs, RgArgsOptions } from './quick-open-filter'

// rg/git glob metacharacters; escape embedded dir names so a dir named
// `feature[1]` doesn't exclude `feature1`.
const GLOB_META = new Set<string>(['*', '?', '[', ']', '{', '}', '\\'])

function escapeGlob(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    out += GLOB_META.has(ch) ? `\\${ch}` : ch
  }
  return out
}

function escapeGlobPath(relPath: string): string {
  // Split on '/' so the separators are not themselves escaped.
  return relPath.split('/').map(escapeGlob).join('/')
}

/** The shapes the dispatch adapter reads the way the fallback does. serde takes
 *  each prefix with `as_str` and DROPS a non-string, where `escapeGlobPath`
 *  throws the twin's TypeError — prefixes reach the relay off the wire. */
function isDispatchablePrefixList(prefixes: readonly string[]): boolean {
  return Array.isArray(prefixes) && prefixes.every((prefix) => typeof prefix === 'string')
}

/** Same reason, plus `forceSlashSeparator`: serde reads it with `as_bool` and a
 *  truthy non-boolean answers `false`, where the twin's `?:` emits the flag. */
function isDispatchableRgOptions(opts: RgArgsOptions): boolean {
  return (
    typeof opts.searchRoot === 'string' &&
    typeof opts.forceSlashSeparator === 'boolean' &&
    isDispatchablePrefixList(opts.excludePathPrefixes)
  )
}

/** `null` means "the seam is unbound, or the argv cannot cross" — never an
 *  answer. An exclude prefix is cut from a real worktree path, and a Windows
 *  directory name may hold an unpaired UTF-16 surrogate; the codec refuses that
 *  (it is not valid UTF-8, so Rust cannot parse the payload at all) and the twin
 *  built the argv without crossing anything, so the caller falls back. Only the
 *  encode rejection is caught; a DispatchCoreError still propagates. */
function dispatchListingArguments(fn: string, input: unknown, root: string): unknown | null {
  try {
    // The module key stays a string LITERAL: report-rust-orphan-ports.mjs can only
    // attribute a dispatch site whose key is a literal node, and hoisting it to a
    // const drops this module into that report's UNRESOLVABLE bucket.
    return tryOrcaDispatch('quick-open-filter', fn, input, { root })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** The deleted twin's body, verbatim over the kept blocklist data. */
function legacyBuildHiddenDirExcludeGlobs(): string[] {
  const names = [NON_DOTTED_PRUNE, ...HIDDEN_DIR_BLOCKLIST]
  const out: string[] = []
  for (const name of names) {
    out.push('--glob', `!**/${escapeGlob(name)}`)
  }
  for (const blockedPath of HIDDEN_PATH_BLOCKLIST) {
    out.push('--glob', `!**/${escapeGlobPath(blockedPath)}`)
  }
  return out
}

/**
 * Build the hidden-dir traversal-pruning glob args for rg (includes `node_modules`).
 * Uses directory-match form `!**\/name` not contents form `!**\/name/**`: rg still
 * descends into a dir matched only by the contents form, so only the directory form
 * actually prunes traversal.
 */
export function buildHiddenDirExcludeGlobs(): string[] {
  const answer = dispatchListingArguments('buildHiddenDirExcludeGlobs', undefined, 'input')
  return answer === null ? legacyBuildHiddenDirExcludeGlobs() : (answer as string[])
}

/** The deleted twin's body, verbatim; composes the LOCAL glob builder, because a
 *  fallback that dispatches is not a fallback. */
function legacyBuildRgArgsForQuickOpen(opts: RgArgsOptions): RgArgs {
  const sepArgs = opts.forceSlashSeparator ? ['--path-separator', '/'] : []
  const hiddenDirGlobs = legacyBuildHiddenDirExcludeGlobs()
  const excludeGlobs: string[] = []
  for (const prefix of opts.excludePathPrefixes) {
    // Directory-match form so rg prunes the nested worktree's traversal, not just its listed files.
    excludeGlobs.push('--glob', `!${escapeGlobPath(prefix)}`)
    excludeGlobs.push('--glob', `!${escapeGlobPath(prefix)}/**`)
  }

  const primary = [
    '--files',
    '--hidden',
    ...sepArgs,
    ...hiddenDirGlobs,
    ...excludeGlobs,
    opts.searchRoot
  ]

  // Ignored pass: --no-ignore-vcs broadens to gitignored/parent/global ignored files; blocklist globs still guard.
  const ignoredPass = [
    '--files',
    '--hidden',
    '--no-ignore-vcs',
    ...sepArgs,
    ...hiddenDirGlobs,
    ...excludeGlobs,
    opts.searchRoot
  ]

  return { primary, ignoredPass }
}

/**
 * Build the two rg arg arrays for Quick Open. Caller must spawn with `cwd: rootPath` — root-relative
 * globs are evaluated against rg's cwd, so omitting it silently breaks nested-worktree exclusions.
 * Deliberately omits `--follow` so symlinks can't escape the authorized root or cause traversal loops.
 */
export function buildRgArgsForQuickOpen(opts: RgArgsOptions): RgArgs {
  if (!isDispatchableRgOptions(opts)) {
    return legacyBuildRgArgsForQuickOpen(opts)
  }
  // Only the three fields the core reads cross, never the caller's object, so an
  // unread sibling key cannot refuse the encode for every scan.
  const answer = dispatchListingArguments(
    'buildRgArgsForQuickOpen',
    {
      searchRoot: opts.searchRoot,
      excludePathPrefixes: [...opts.excludePathPrefixes],
      forceSlashSeparator: opts.forceSlashSeparator
    },
    'opts'
  )
  return answer === null ? legacyBuildRgArgsForQuickOpen(opts) : (answer as RgArgs)
}

/** The deleted twin's body, verbatim. */
function legacyBuildGitLsFilesArgsForQuickOpen(
  excludePathPrefixes: readonly string[]
): GitLsFilesArgs {
  const excludeSpecs: string[] = []
  for (const prefix of excludePathPrefixes) {
    excludeSpecs.push(`:(exclude,glob)${escapeGlobPath(prefix)}`)
    excludeSpecs.push(`:(exclude,glob)${escapeGlobPath(prefix)}/**`)
  }
  const trailingPathspecs = excludeSpecs.length > 0 ? ['--', '.', ...excludeSpecs] : []
  // Why: collapse untracked trees before Git traverses them; callers expand
  // only allowed directory placeholders with the shared bounded walker.
  const directoryCollapseArgs = ['--directory', '--no-empty-directory']

  // Why: NUL preserves real Git paths; stage mode identifies gitlinks without
  // lstat probes for ordinary tracked files.
  const primary = [
    '-z',
    '-s',
    '--cached',
    '--others',
    '--exclude-standard',
    ...directoryCollapseArgs,
    ...trailingPathspecs
  ]
  const ignoredPass = [
    '-z',
    '-s',
    '--others',
    '--ignored',
    '--exclude-standard',
    ...directoryCollapseArgs,
    ...trailingPathspecs
  ]
  return { primary, ignoredPass }
}

/**
 * Build the two `git ls-files` arg arrays for Quick Open. Exclude prefixes are
 * encoded as `:(exclude,glob)` pathspecs with a positive `.` pathspec prepended;
 * the ignored pass asks git for ignored untracked files. Non-git roots keep
 * their non-git fallback limits in callers.
 */
export function buildGitLsFilesArgsForQuickOpen(
  excludePathPrefixes: readonly string[] = []
): GitLsFilesArgs {
  if (!isDispatchablePrefixList(excludePathPrefixes)) {
    return legacyBuildGitLsFilesArgsForQuickOpen(excludePathPrefixes)
  }
  const answer = dispatchListingArguments(
    'buildGitLsFilesArgsForQuickOpen',
    { excludePathPrefixes: [...excludePathPrefixes] },
    'excludePathPrefixes'
  )
  return answer === null
    ? legacyBuildGitLsFilesArgsForQuickOpen(excludePathPrefixes)
    : (answer as GitLsFilesArgs)
}
