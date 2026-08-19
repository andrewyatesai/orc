// Tree-agnostic worktree-id parsing, driven by the Rust `orca_core::worktree_id`
// core. It lives on `orca-dispatch-seam` rather than in one tree's binding
// directory because a worktree id is parsed on EVERY surface: main + cli (napi),
// the SSH relay (wasm via initSync), the renderer (wasm at ready), the mobile
// client and the Playwright specs (never bound at all). One shim serves them
// because the fallback below is the answer, not a degrade.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED. These values are worktree
// IDENTITY: the repo id keys `worktreesByRepo`/`reposById`, the parsed path
// becomes a PTY cwd and a git working directory, and both are persisted. Every
// return type is already total — a string, or `ParsedWorktreeId | null` where
// `null` is the twin's real answer for "no `::` in this id" — so there is no
// spare state a sentinel could occupy (ported-modules.md "Signal at the level
// that has a spare state"; lifting to a list does not help, each answer decides
// ONE id). A wrong repo id silently files a worktree under a repo that does not
// own it; a wrong path runs an agent in the wrong directory. So each fallback
// rebuilds the deleted twin's body verbatim from the constants the twin still
// exports, which makes pre-ready equal ready for EVERY input — the same shape
// `git-push-target-shape` and `terminal-tab-id-validity` use, for the same reason.
//
// Measured, not asserted: 15,176 adversarial cases (3,794 ids × 4 functions,
// covering every JS/Rust whitespace code point, repeated `::`, `::workspace:`
// suffix near-misses, multibyte and astral path segments, plus an exhaustive
// enumeration over `[: w / space BOM NEL é]` up to length 4) were run through
// `orca-parity` and diffed against the twin. The three dispatched functions
// agreed on all 11,382 of their cases.
//
// getWorktreePathBasenameFromId is COMPOSED here instead of dispatched, and that
// is the one deliberate deviation. `orca_core::worktree_id::
// get_worktree_path_basename_from_id` trims with Rust's `char::is_whitespace`
// where the twin used JS `String.prototype.trim`, and the two sets differ on
// exactly two code points: U+0085 NEL (Rust trims, JS does not) and U+FEFF BOM
// (JS trims, Rust does not). That is 72 divergent answers in the sweep, e.g.
// `repo::/abs/path/name<U+FEFF>` → twin `"name"`, core `"name<U+FEFF>"`, and the
// result is PERSISTED (main/persistence.ts stamps it into
// `automationRuns[].workspaceDisplayName` and flushes). Dispatching it would
// therefore ship a behaviour change, and correcting the core means rebuilding
// the committed wasm/napi artifacts — out of scope here. The id-parsing half
// still goes through Rust: this composes over splitWorktreeIdForFilesystem.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  FOLDER_WORKSPACE_INSTANCE_SUFFIX,
  WORKTREE_ID_SEPARATOR,
  type ParsedWorktreeId
} from './worktree-id'

export type { ParsedWorktreeId } from './worktree-id'

/**
 * Dispatch one id to the Rust core, or answer with the fallback.
 *
 * `fallback` is computed by the CALLER before we get here, on purpose: a
 * non-string id (the type says string, but ids also arrive from persisted JSON
 * and off the wire) must throw the same TypeError the twin threw, and it has to
 * throw on the ready path too — the encoder would happily send `undefined` as
 * the documented no-arg call and Rust would answer `""`.
 *
 * A `null` from `tryOrcaDispatch` means "no binding", which for the two split
 * functions is indistinguishable from a real `null` answer. Collapsing them is
 * safe here and nowhere else: this shim is `parity`, so the fallback recomputes
 * the same `null`.
 */
function dispatchWorktreeId<T>(fn: string, worktreeId: string, fallback: T): T {
  try {
    const answer = tryOrcaDispatch('worktree-id', fn, worktreeId, { root: 'worktreeId' })
    return answer === null ? fallback : (answer as T)
  } catch (error) {
    // Why the catch: on Windows a directory name can hold an unpaired UTF-16
    // surrogate, so an id built from a real path can too. The codec refuses it
    // (it is not valid UTF-8 and cannot cross into Rust at all) and the twin
    // answered it without crossing anything, so the fallback is that same
    // answer. Only the encode rejection is caught; a DispatchCoreError still
    // propagates.
    if (error instanceof DispatchPayloadError) {
      return fallback
    }
    throw error
  }
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  const fallback = separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
  return dispatchWorktreeId('getRepoIdFromWorktreeId', worktreeId, fallback)
}

function legacySplitWorktreeId(worktreeId: string): ParsedWorktreeId | null {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  if (separatorIdx === -1) {
    return null
  }
  return {
    repoId: worktreeId.slice(0, separatorIdx),
    worktreePath: worktreeId.slice(separatorIdx + WORKTREE_ID_SEPARATOR.length)
  }
}

export function splitWorktreeId(worktreeId: string): ParsedWorktreeId | null {
  return dispatchWorktreeId('splitWorktreeId', worktreeId, legacySplitWorktreeId(worktreeId))
}

export function splitWorktreeIdForFilesystem(worktreeId: string): ParsedWorktreeId | null {
  const parsed = legacySplitWorktreeId(worktreeId)
  const fallback = parsed
    ? {
        repoId: parsed.repoId,
        // Why: folder projects can have multiple workspace sessions backed by the
        // same directory. Their IDs carry a UUID suffix, but filesystem callers
        // still need the real folder path as cwd/root.
        worktreePath: parsed.worktreePath.replace(FOLDER_WORKSPACE_INSTANCE_SUFFIX, '')
      }
    : null
  return dispatchWorktreeId('splitWorktreeIdForFilesystem', worktreeId, fallback)
}

export function getWorktreePathBasenameFromId(worktreeId: string): string | null {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const normalizedPath = parsed?.worktreePath.trim().replace(/[\\/]+$/g, '') ?? ''
  if (!normalizedPath) {
    return null
  }
  const basename = normalizedPath.split(/[\\/]/).findLast(Boolean)?.trim()
  return basename || null
}
