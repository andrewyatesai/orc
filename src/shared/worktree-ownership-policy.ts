// Worktree ownership classification + external-visibility policy on the Rust
// `orca_core::worktree_ownership` core. It sits on `orca-dispatch-seam` rather
// than in one tree's binding directory because the callers span both trees: main
// builds every detected row (`ipc/worktrees.ts`, `runtime/orca-runtime.ts`,
// napi), main also reads the legacy flag while persisting (`persistence.ts`),
// the renderer draws the visibility controls off the same policy
// (`sidebar/WorktreeList.tsx`, `WorktreeVisibilityDialog.tsx`,
// `imported-worktrees-card-candidates.ts`, wasm at ready), and the shared
// `external-worktree-inbox.ts` calls it from whichever surface is asking.
//
// `buildKnownOrcaWorkspaceLayouts` moved to `orca-workspace-layouts.ts` — same
// core module, separate concern, and one file would not fit `max-lines`.
//
// THE ONE INPUT WITH NO JSON FORM. `agentScratchWorktreePathMatcher` was a
// CLOSURE, so it could not cross. It is now `agentScratchCheckoutPaths` — the
// array the callers already built the matcher from — and each side builds its
// own matcher from it, so the compared call is the real one. Absent ≡ the twin's
// absent matcher (the repo-root fallback); `[]` is a real matcher that matches
// nothing, and the two answer differently. The fallback memoizes the matcher on
// the array identity so a fan-out still normalizes each checkout once rather
// than once per candidate, which is the whole reason the twin took a closure.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED.
//
// Getting `ownership` wrong un-hides every `.claude/worktrees/agent-*` row in
// the sidebar, which is exactly the regression #9535 and #9388 fixed, and
// `visible` decides whether a row exists for the user at all. Neither type has a
// spare state: `WorktreeOwnership` has four real members and `unknown-legacy` is
// the twin's own answer for "no evidence", `visible` is a bare boolean consumed
// as `.filter((w) => w.visible)`, and `DetectedWorktree` is a ROW — a per-row
// sentinel has nowhere to go (ported-modules.md, "Signal at the level that has a
// spare state"), while dropping every row lands on `[]`, which already means
// "this repo has no worktrees". `applyMetadataFallbackVisibility` is worse
// still: it runs exactly when the git scan already FAILED, so it is the last
// evidence there is.
//
// So each fallback re-runs the deleted twin's body over the data that stayed in
// TypeScript — `EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT` in `worktree-ownership.ts`,
// the scratch prefixes in `agent-scratch-worktrees.ts`, the import override in
// `external-worktree-inbox.ts` — which makes pre-ready equal ready for every
// input. `tools/parity/dispatch/worktree-ownership.ts` drives THIS module with
// the seam unbound, so all 60 corpus vectors re-check that claim on every
// `pnpm parity`.
//
// WHAT DOES NOT CROSS, and why each one is answered locally instead. The
// adapter reads a JSON value with a typed accessor, so a value of the wrong
// runtime TYPE reads as absent there while the twin read it with JS truthiness.
// Persisted `orca-data.json` is hand-editable and repo records also arrive off
// the relay wire, so these are inputs, not hypotheticals:
//   * `externalWorktreeVisibility` outside `'show' | 'hide' | undefined`.
//     `null` is the reachable one — `parse_visibility` answers None for it, and
//     `isLegacyRepoForExternalWorktreeVisibility` then returns true where the
//     twin's `=== undefined` was false.
//   * an `ownership` outside the four members (`should_show_worktree` folds it
//     to `unknown-legacy`, which a legacy repo SHOWS; the twin fell through to
//     the visibility setting).
//   * a non-number `orcaCreatedAt` / `createdAt` or a non-string
//     `sparseBaseRef` / `sparsePresetId` (`as_f64` / `as_str` answer None, so a
//     strong marker would read as no marker and un-manage the worktree).
//   * a non-boolean `isSelectedCheckout` / `isLegacyRepoForVisibility`.
// The other four metadata markers are PRESENCE flags in the core, so they cross
// as `Boolean(...)`, which is what `is_truthy` reads and keeps the caller's
// `pushTarget` / layout objects — user text — off the wire entirely.
//
// MEASURED, not assumed, and THREE-way rather than the usual two. 1,206,741
// comparisons of the HEAD twin against BOTH shim states — the fallback with the
// seam unbound, and the shipped wasm core with it bound — agreed on every one.
// A fallback-vs-core differential cannot see a bound-only divergence, which is
// why the twin is the third oracle and why `worktree-ownership-bound-state.test.ts`
// pins the scratch answers in both states. The corpus: the visibility, legacy
// and addedAt cross products exhaustively (including `null`, `NaN`, `±Infinity`,
// `-0` and an off-union `'maybe'`); every strong-metadata marker singly and in
// PAIRS over 11 values each; every scratch marker placed under 9 filesystem
// roots in both separators with three depths and four checkout sets; and 160,000
// random paths built from 30 atoms (drive letters, UNC and `wsl$`/`wsl.localhost`
// aliases, `.claude/worktrees`, U+212A, U+FEFF, U+0085, an astral scalar, a
// newline) driven through all seven exports. Two classes had to be CORRECTED
// first rather than shipped: the WSL line-terminator fold now in
// `orca-workspace-layouts.ts`, and the wrong-runtime-type list above.
//
// DECLARED COST, measured against the twin as it actually ran (seam BOUND on both
// sides, because the twin's path helpers already dispatched):
// `buildKnownOrcaWorkspaceLayouts` got FASTER — 15.4us -> 9.5us, one crossing
// instead of one per path helper — while `toDetectedWorktree` got slower, and
// the slowdown GROWS with the checkout count: 12.0->25.6us at 8 checkouts,
// 17.3->43.7us at 40, 18.2->155.6us at 200. The twin was flat in that count
// because its matcher was built once per fan-out; the seam is stateless, so the
// array is re-encoded on every row, making a listing O(worktrees x checkouts).
// At 40 worktrees that is ~1.7ms per listing and invisible; at 200 it is ~31ms,
// which is real. The fix is a core-side change, not a shim one — an arm that
// takes a pre-built matcher handle, or a scratch verdict computed once per
// fan-out — and it is deliberately NOT hidden behind a TypeScript prefilter
// here, because a "cheap necessary condition" on the marker segments would put
// half the #9388 decision back in TypeScript to save microseconds.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  legacyApplyMetadataFallbackVisibility,
  legacyAreRuntimePathsEqual,
  legacyClassifyWorktreeOwnership,
  legacyDecideDetectedWorktree,
  legacyEffectiveExternalWorktreeVisibility,
  legacyIsLegacyRepoForExternalWorktreeVisibility,
  legacyShouldShowWorktree,
  type DetectedWorktreeInput,
  type ShouldShowWorktreeInput,
  type WorktreeOwnershipDecision,
  type WorktreeOwnershipInput
} from './worktree-ownership-rules'
import type {
  DetectedWorktree,
  ExternalWorktreeVisibility,
  Repo,
  Worktree,
  WorktreeMeta,
  WorktreeOwnership
} from './types'

export type {
  DetectedWorktreeInput,
  ShouldShowWorktreeInput,
  WorktreeOwnershipInput
} from './worktree-ownership-rules'

const MODULE = 'worktree-ownership'

export function isLegacyRepoForExternalWorktreeVisibility(repo: Repo): boolean {
  if (!crossesAsVisibility(repo.externalWorktreeVisibility)) {
    return legacyIsLegacyRepoForExternalWorktreeVisibility(repo)
  }
  const answer = dispatchOwnership('isLegacyRepoForExternalWorktreeVisibility', {
    externalWorktreeVisibility: repo.externalWorktreeVisibility,
    externalWorktreeVisibilityLegacy: repo.externalWorktreeVisibilityLegacy,
    addedAt: repo.addedAt
  })
  return answer === null
    ? legacyIsLegacyRepoForExternalWorktreeVisibility(repo)
    : (answer as boolean)
}

export function effectiveExternalWorktreeVisibility(
  repo: Pick<Repo, 'externalWorktreeVisibility'>,
  isLegacyRepoForVisibility: boolean
): ExternalWorktreeVisibility {
  if (
    !crossesAsVisibility(repo.externalWorktreeVisibility) ||
    typeof isLegacyRepoForVisibility !== 'boolean'
  ) {
    return legacyEffectiveExternalWorktreeVisibility(repo, isLegacyRepoForVisibility)
  }
  const answer = dispatchOwnership('effectiveExternalWorktreeVisibility', {
    repo: { externalWorktreeVisibility: repo.externalWorktreeVisibility },
    isLegacyRepoForVisibility
  })
  return answer === null
    ? legacyEffectiveExternalWorktreeVisibility(repo, isLegacyRepoForVisibility)
    : (answer as ExternalWorktreeVisibility)
}

export function classifyWorktreeOwnership(args: WorktreeOwnershipInput): WorktreeOwnership {
  if (!crossesAsMeta(args.meta)) {
    return legacyClassifyWorktreeOwnership(args)
  }
  const answer = dispatchOwnership('classifyWorktreeOwnership', {
    repo: { path: args.repo.path },
    worktree: leanWorktree(args.worktree),
    meta: leanMeta(args.meta),
    knownOrcaLayouts: args.knownOrcaLayouts,
    agentScratchCheckoutPaths: args.agentScratchCheckoutPaths
  })
  return answer === null ? legacyClassifyWorktreeOwnership(args) : (answer as WorktreeOwnership)
}

/**
 * The detected row for one worktree: the caller's worktree with the three
 * decided fields on it. The spread is TypeScript on purpose — the core answers
 * the CLASSIFICATION and nothing else, so a row keeps its id, branch, links and
 * every other field the caller already filled in.
 */
export function toDetectedWorktree(args: DetectedWorktreeInput): DetectedWorktree {
  const decided = decideDetectedWorktree(args)
  return { ...args.worktree, ...decided }
}

export function shouldShowWorktree(args: ShouldShowWorktreeInput): boolean {
  if (
    !crossesAsVisibility(args.repo.externalWorktreeVisibility) ||
    !crossesAsOwnership(args.ownership) ||
    typeof args.isLegacyRepoForVisibility !== 'boolean' ||
    typeof args.isSelectedCheckout !== 'boolean'
  ) {
    return legacyShouldShowWorktree(args)
  }
  const answer = dispatchOwnership('shouldShowWorktree', {
    worktree: { path: args.worktree.path },
    ownership: args.ownership,
    repo: { externalWorktreeVisibility: args.repo.externalWorktreeVisibility },
    isLegacyRepoForVisibility: args.isLegacyRepoForVisibility,
    isSelectedCheckout: args.isSelectedCheckout,
    importedExternalWorktreePaths: args.importedExternalWorktreePaths
  })
  return answer === null ? legacyShouldShowWorktree(args) : (answer as boolean)
}

/**
 * The git scan failed, so metadata is the only evidence left: fail open, reveal
 * the row and demote any non-managed ownership to `unknown-legacy`. Agent
 * scratch is handed back UNTOUCHED — its policy (hidden unless explicitly
 * imported or the selected checkout) has to survive the fallback, and returning
 * the very same object is what the twin did.
 */
export function applyMetadataFallbackVisibility(detected: DetectedWorktree): DetectedWorktree {
  // Why the guard: the twin read `detected.ownership` and threw a TypeError on a
  // non-object, which no caller catches. The arm answers `__parity_error__`
  // instead, and a bound seam would turn the twin's TypeError into a
  // DispatchCoreError from a different file.
  if (!isDetectedRow(detected)) {
    return legacyApplyMetadataFallbackVisibility(detected)
  }
  const answer = dispatchOwnership('applyMetadataFallbackVisibility', {
    path: detected.path,
    isMainWorktree: detected.isMainWorktree,
    ownership: detected.ownership,
    selectedCheckout: detected.selectedCheckout,
    visible: detected.visible
  })
  if (answer === null) {
    return legacyApplyMetadataFallbackVisibility(detected)
  }
  const decided = answer as Pick<DetectedWorktree, 'ownership' | 'visible'>
  // Read off the ANSWER, not the input: `agent-scratch` comes back only when the
  // core left the row alone, which is the case the twin returned by reference.
  return decided.ownership === 'agent-scratch'
    ? detected
    : { ...detected, ownership: decided.ownership, visible: decided.visible }
}

export function areRuntimePathsEqual(leftPath: string, rightPath: string): boolean {
  const answer = dispatchOwnership('areRuntimePathsEqual', { leftPath, rightPath })
  return answer === null ? legacyAreRuntimePathsEqual(leftPath, rightPath) : (answer as boolean)
}

/** `null` = the seam is unbound, or the payload cannot cross — answer locally.
 *  Unambiguous: every arm answers a string, a bool or an object, never null.
 *  Why the catch: worktree paths come off the filesystem and a sparse ref is
 *  user-typed, so an unpaired UTF-16 surrogate is reachable and the codec
 *  refuses to encode it. The twin answered those without crossing anything, so
 *  the fallback does too; a DispatchCoreError still propagates. */
function dispatchOwnership(fn: string, input: unknown): unknown {
  try {
    return tryOrcaDispatch(MODULE, fn, input, { root: fn, undefinedProperties: 'omit' })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

function decideDetectedWorktree(args: DetectedWorktreeInput): WorktreeOwnershipDecision {
  if (
    !crossesAsMeta(args.meta) ||
    !crossesAsVisibility(args.repo.externalWorktreeVisibility) ||
    !(
      args.isLegacyRepoForVisibility === undefined ||
      typeof args.isLegacyRepoForVisibility === 'boolean'
    )
  ) {
    return legacyDecideDetectedWorktree(args)
  }
  const answer = dispatchOwnership('toDetectedWorktree', {
    repo: leanRepo(args.repo),
    worktree: leanWorktree(args.worktree),
    meta: leanMeta(args.meta),
    knownOrcaLayouts: args.knownOrcaLayouts,
    isLegacyRepoForVisibility: args.isLegacyRepoForVisibility,
    agentScratchCheckoutPaths: args.agentScratchCheckoutPaths
  })
  return answer === null
    ? legacyDecideDetectedWorktree(args)
    : (answer as WorktreeOwnershipDecision)
}

/** Only the fields the core reads. Never the caller's `Repo`: its display name,
 *  comment and remote identity are user text with no bearing on ownership. */
function leanRepo(repo: Repo) {
  return {
    path: repo.path,
    externalWorktreeVisibility: repo.externalWorktreeVisibility,
    externalWorktreeVisibilityLegacy: repo.externalWorktreeVisibilityLegacy,
    addedAt: repo.addedAt,
    importedExternalWorktreePaths: repo.importedExternalWorktreePaths
  }
}

function leanWorktree(worktree: Pick<Worktree, 'path' | 'isMainWorktree'>) {
  return { path: worktree.path, isMainWorktree: worktree.isMainWorktree }
}

/** The eight strong-ownership markers. The four the core models as PRESENCE
 *  cross as `Boolean(...)` — exactly what `is_truthy` reads — so a `pushTarget`
 *  or a creation layout never puts user text on the wire. */
function leanMeta(meta: WorktreeMeta | undefined) {
  return (
    meta && {
      orcaCreatedAt: meta.orcaCreatedAt,
      orcaCreationWorkspaceLayout: Boolean(meta.orcaCreationWorkspaceLayout),
      createdAt: meta.createdAt,
      createdWithAgent: Boolean(meta.createdWithAgent),
      pushTarget: Boolean(meta.pushTarget),
      sparseBaseRef: meta.sparseBaseRef,
      sparsePresetId: meta.sparsePresetId,
      preserveBranchOnDelete: Boolean(meta.preserveBranchOnDelete)
    }
  )
}

function isDetectedRow(value: unknown): value is DetectedWorktree {
  return typeof value === 'object' && value !== null
}

function crossesAsVisibility(value: unknown): boolean {
  return value === undefined || value === 'show' || value === 'hide'
}

function crossesAsOwnership(value: unknown): boolean {
  return (
    value === 'orca-managed' ||
    value === 'external' ||
    value === 'unknown-legacy' ||
    value === 'agent-scratch'
  )
}

function crossesAsDeclared(value: unknown, kind: 'number' | 'string'): boolean {
  return value === undefined || value === null || typeof value === kind
}

function crossesAsMeta(meta: WorktreeMeta | undefined): boolean {
  return (
    meta === undefined ||
    (crossesAsDeclared(meta.orcaCreatedAt, 'number') &&
      crossesAsDeclared(meta.createdAt, 'number') &&
      crossesAsDeclared(meta.sparseBaseRef, 'string') &&
      crossesAsDeclared(meta.sparsePresetId, 'string'))
  )
}
