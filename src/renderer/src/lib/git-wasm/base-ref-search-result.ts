// Legacy base-ref search-result derivation, driven by the Rust orca-core
// base_ref_search_result port in the orca-git wasm module (the shared TS impl
// was deleted; src/shared/base-ref-search-result.ts is the type re-export only).
//
// A ref search has THREE answers — rows found, nothing matched (`[]`), and
// could-not-search — but `BaseRefSearchResult` is one ROW, so a per-row shim can
// only express the first two: a not-ready row must be either invented or
// dropped, and dropping them all lands on `[]`, which the branch picker renders
// as "No matching branches" plus a "create branch <query>" action. Hence the
// list shape here: `null` means could-not-search and is never `[]`.
//
// Why null pre-ready (contract case 3): the deleted TS returned
// `{refName, localBranchName: deriveLegacyLocalBranchName(refName)}`, which
// strips `origin/`/`upstream/` only when a non-empty remainder follows — the
// answer depends on the input, so no constant is honest. The previous identity
// fallback (`localBranchName = refName`) read as a real answer three frames on:
// composer-branch-selection writes localBranchName into `branchNameOverride`/
// `branchAutoName`/`name`, so picking `origin/main` created a branch literally
// named `origin/main`, and its `refName === localBranchName` test then
// classified that remote ref as an already-local branch.
//
// handledBy: `searchRuntimeRepoBaseRefDetails` (runtime/runtime-repo-client.ts)
// and the web preload's `repos.searchBaseRefDetails` both throw
// `BaseRefDetailsUnavailableError` on null, so the search REJECTS —
// useCreatePullRequestDialogFields shows "Branch discovery failed." and
// SmartWorkspaceNameField shows its branch-search failure line instead of the
// empty-results hint. No ready-edge resubscribe: startup hydration is gated on
// the core, so a not-ready call here has found a core that failed permanently
// (git-wasm-availability `unavailable`), and recomputing would never help.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { BaseRefSearchResult } from '../../../../shared/types'

/** Thrown by the two ref-search callers when the derivation core is unavailable,
 *  so "could not search" surfaces as a failure and never as the empty array that
 *  means "no branches matched". */
export class BaseRefDetailsUnavailableError extends Error {
  constructor() {
    super('Branch details are unavailable because the git core failed to load.')
    this.name = 'BaseRefDetailsUnavailableError'
  }
}

/**
 * Derive one result row per display ref, for mixed-version runtimes that answer
 * `repo.searchRefs` with `refs` but no `refDetails`.
 *
 * Returns `null` when the core cannot answer — see the header: that is
 * could-not-search, NOT an empty result set, and callers must not `?? []` it.
 */
export function legacyBaseRefSearchResults(
  refNames: readonly string[]
): BaseRefSearchResult[] | null {
  if (!isGitWasmReady()) {
    return null
  }
  // Payload is a bare ref-name string, so the codec's default applies unrelaxed.
  return refNames.map(
    (refName) =>
      dispatchToWasmCore('base-ref-search-result', 'legacyBaseRefSearchResult', refName, {
        root: 'refName'
      }) as BaseRefSearchResult
  )
}
