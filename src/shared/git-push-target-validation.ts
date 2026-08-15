// Logic moved to the Rust `orca_core::git_push_target` core; this twin keeps only
// the DATA the push-target safety rules are made of. Consumers reach the core
// through the seam their tree owns:
//   src/shared/* (main IPC + relay) -> src/shared/git-push-target-shape.ts (orca-dispatch seam)
//   src/main/git/*                  -> src/main/git/rust-push-target-validation.ts (napi)
//
// Why the constants stay: the seam shim rebuilds the deleted body from them for
// the two cases that never reach Rust — an unbound seam, and a field the dispatch
// codec refuses to encode (a lone UTF-16 surrogate off the wire). An `asserts`
// function has no spare state for a not-ready signal, and this is the
// anti-traversal gate on a value replayed into `git push`, so its pre-ready
// answer MUST be the twin's answer for every input (see the header there).

/** Git accepts slash-separated remote names; each segment must still be a
 *  concrete name so a persisted target cannot smuggle `.`/`..` traversal. */
export const SAFE_GIT_REMOTE_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Remote names longer than this are refused before any segment check. */
export const MAX_GIT_REMOTE_NAME_LENGTH = 100

/** The only two remote-URL shapes a PR push target may carry. */
export const GITHUB_CLONE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/
export const GITHUB_SSH_URL = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/
