// The deleted `worktree-ownership.ts` decision rules, kept in TypeScript as the
// PRE-READY FALLBACK for `worktree-ownership-policy.ts` — nothing else may call
// them. The Rust `orca_core::worktree_ownership` core is the implementation the
// app runs; these bodies exist because that shim's contract is `parity`, and a
// shim whose fallback dispatches is not a fallback (the reasoning, the measured
// agreement and the residuals are all in the policy shim's header).
//
// They are the twin VERBATIM, over data that also stayed in TypeScript:
// `EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT` in `worktree-ownership.ts`, the
// scratch prefix table in `agent-scratch-worktrees.ts`, the explicit-import
// override in `external-worktree-inbox.ts`. Editing one side only is caught by
// `pnpm parity`, which drives the shim seam-unbound and therefore compares
// exactly this code against Rust.
//
// The two agent-scratch WORKTREE matchers moved here bodily when that module was
// cut over, because this file was their only consumer and shimming them would
// have made this fallback dispatch. Their ready path is unaffected: the policy
// shim sends `agentScratchCheckoutPaths` and the Rust core builds the same
// matcher. `isAgentScratchRepoRootPath` is not here — it had a caller outside
// this fallback and did become a shim, in `agent-scratch-repo-roots.ts`.
//
// It lives in its own file because the shim plus these bodies do not fit
// `max-lines`, and a `max-lines` disable is forbidden.
import {
  AGENT_SCRATCH_PATH_PREFIXES,
  type AgentScratchWorktreePathMatcher
} from './agent-scratch-worktrees'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from './cross-platform-path-resolution'
import { isExplicitlyImportedExternalWorktreePath } from './external-worktree-inbox'
import { EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT } from './worktree-ownership'
import type {
  DetectedWorktree,
  ExternalWorktreeVisibility,
  OrcaWorkspaceLayout,
  Repo,
  Worktree,
  WorktreeMeta,
  WorktreeOwnership
} from './types'

/** The classifier's inputs, minus the closure the twin took. */
export type WorktreeOwnershipInput = {
  repo: Pick<Repo, 'path'>
  worktree: Pick<Worktree, 'path' | 'isMainWorktree'>
  meta?: WorktreeMeta
  knownOrcaLayouts: OrcaWorkspaceLayout[]
  /** Every checkout a scratch directory may hang off — `[repo.path, ...worktree
   *  paths]` at the call sites. Absent falls back to the repo root alone. */
  agentScratchCheckoutPaths?: readonly string[]
}

export type DetectedWorktreeInput = Omit<WorktreeOwnershipInput, 'repo' | 'worktree'> & {
  repo: Repo
  worktree: Worktree
  isLegacyRepoForVisibility?: boolean
}

export type ShouldShowWorktreeInput = {
  worktree: Pick<Worktree, 'path'>
  ownership: WorktreeOwnership
  repo: Pick<Repo, 'externalWorktreeVisibility'>
  isLegacyRepoForVisibility: boolean
  isSelectedCheckout: boolean
  importedExternalWorktreePaths?: readonly string[] | undefined
}

/** The three fields the core decides; the caller's row carries the rest. */
export type WorktreeOwnershipDecision = Pick<
  DetectedWorktree,
  'ownership' | 'selectedCheckout' | 'visible'
>

// Why memoized on the array identity: the twin took a pre-built closure so a
// fan-out normalized each checkout once. Every call site hoists the array out of
// its loop, so this keeps that O(checkouts) work off the per-worktree path —
// each normalize is itself a seam crossing.
const MATCHERS_BY_CHECKOUT_PATHS = new WeakMap<object, AgentScratchWorktreePathMatcher>()

export function agentScratchMatcher(
  checkoutPaths: readonly string[] | undefined
): AgentScratchWorktreePathMatcher | undefined {
  if (!checkoutPaths) {
    return undefined
  }
  const cached = MATCHERS_BY_CHECKOUT_PATHS.get(checkoutPaths)
  if (cached) {
    return cached
  }
  const matcher = legacyAgentScratchWorktreePathMatcher(checkoutPaths)
  MATCHERS_BY_CHECKOUT_PATHS.set(checkoutPaths, matcher)
  return matcher
}

/** The deleted `createAgentScratchWorktreePathMatcher`, verbatim over the kept
 *  prefix table. The closure is the twin's shape: a fan-out normalizes each
 *  checkout once, not once per candidate. */
export function legacyAgentScratchWorktreePathMatcher(
  checkoutPaths: readonly string[]
): AgentScratchWorktreePathMatcher {
  const checkoutPathKeys = new Set(checkoutPaths.map(normalizeRuntimePathForComparison))
  return (worktreePath) => {
    const segments = normalizeRuntimePathForComparison(worktreePath).split('/')
    for (const prefix of AGENT_SCRATCH_PATH_PREFIXES) {
      // Strict `<`: the marker must have a descendant, so the container itself
      // (`<repo>/.gsd-workspaces`) is not a scratch worktree.
      for (let index = 0; index + prefix.length < segments.length; index += 1) {
        if (!prefix.every((segment, offset) => segments[index + offset] === segment)) {
          continue
        }
        const checkoutPath = segments.slice(0, index).join('/')
        // Why: splitting strips the separator from filesystem roots, but normalized checkout keys retain it.
        const checkoutPathKey = /^[a-z]:$/i.test(checkoutPath)
          ? `${checkoutPath}/`
          : checkoutPath || '/'
        if (checkoutPathKeys.has(checkoutPathKey)) {
          return true
        }
      }
    }
    return false
  }
}

/** The deleted `isAgentScratchWorktreePath`, verbatim: only the repo root counts
 *  as a registered checkout. */
export function legacyIsAgentScratchWorktreePath(repoPath: string, worktreePath: string): boolean {
  return legacyAgentScratchWorktreePathMatcher([repoPath])(worktreePath)
}

/** The deleted twin's body, verbatim over the kept rollout constant. */
export function legacyIsLegacyRepoForExternalWorktreeVisibility(repo: Repo): boolean {
  if (typeof repo.externalWorktreeVisibilityLegacy === 'boolean') {
    return repo.externalWorktreeVisibilityLegacy
  }
  if (repo.externalWorktreeVisibility === undefined) {
    return true
  }
  if (!Number.isFinite(repo.addedAt)) {
    return true
  }
  return repo.addedAt < EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT
}

/** The deleted twin's body, verbatim. */
export function legacyEffectiveExternalWorktreeVisibility(
  repo: Pick<Repo, 'externalWorktreeVisibility'>,
  isLegacyRepoForVisibility: boolean
): ExternalWorktreeVisibility {
  if (repo.externalWorktreeVisibility) {
    return repo.externalWorktreeVisibility
  }
  return isLegacyRepoForVisibility ? 'show' : 'hide'
}

/** The deleted twin's body, verbatim over the kept scratch matcher. */
export function legacyClassifyWorktreeOwnership(args: WorktreeOwnershipInput): WorktreeOwnership {
  if (hasStrongOrcaMetadata(args.meta)) {
    return 'orca-managed'
  }

  // Why: sub-agent scratch worktrees (e.g. .claude/worktrees) are tool
  // plumbing, not workspaces; classify before layout heuristics (#9388).
  if (
    agentScratchMatcher(args.agentScratchCheckoutPaths)?.(args.worktree.path) ??
    legacyIsAgentScratchWorktreePath(args.repo.path, args.worktree.path)
  ) {
    return 'agent-scratch'
  }

  if (isUnderFlatOrUntrustedOrcaRoot(args.worktree.path, args.knownOrcaLayouts)) {
    return 'unknown-legacy'
  }

  if (canClassifyAsExternal(args.worktree.path, args.knownOrcaLayouts)) {
    // Why: a plain `git worktree add` can target Orca's nested workspace
    // folder. Only metadata proves Orca created it.
    return 'external'
  }

  return 'unknown-legacy'
}

/** The deleted twin's body, verbatim, minus the spread the shim now owns. */
export function legacyDecideDetectedWorktree(
  args: DetectedWorktreeInput
): WorktreeOwnershipDecision {
  const ownership = legacyClassifyWorktreeOwnership(args)
  const selectedCheckout = legacyAreRuntimePathsEqual(args.worktree.path, args.repo.path)
  const isLegacyRepoForVisibility =
    args.isLegacyRepoForVisibility ?? legacyIsLegacyRepoForExternalWorktreeVisibility(args.repo)
  const visible = legacyShouldShowWorktree({
    worktree: args.worktree,
    ownership,
    repo: args.repo,
    isLegacyRepoForVisibility,
    isSelectedCheckout: selectedCheckout,
    importedExternalWorktreePaths: args.repo.importedExternalWorktreePaths
  })
  return { ownership, selectedCheckout, visible }
}

/** The deleted twin's body, verbatim over the kept import override. */
export function legacyShouldShowWorktree(args: ShouldShowWorktreeInput): boolean {
  if (args.isSelectedCheckout) {
    return true
  }
  if (args.ownership === 'orca-managed') {
    return true
  }
  if (
    isExplicitlyImportedExternalWorktreePath(args.worktree.path, {
      importedExternalWorktreePaths: args.importedExternalWorktreePaths
    })
  ) {
    return true
  }
  // Why: agent scratch stays hidden even when the repo shows non-Orca
  // worktrees; only an explicit import or selected checkout reveals it.
  if (args.ownership === 'agent-scratch') {
    return false
  }
  if (args.ownership === 'unknown-legacy' && args.isLegacyRepoForVisibility) {
    return true
  }
  return (
    legacyEffectiveExternalWorktreeVisibility(args.repo, args.isLegacyRepoForVisibility) === 'show'
  )
}

/** The deleted twin's body, verbatim. */
export function legacyApplyMetadataFallbackVisibility(
  detected: DetectedWorktree
): DetectedWorktree {
  if (detected.ownership === 'agent-scratch') {
    // Why: retain scratch policy, including explicit imports, while ordinary fallback fails open.
    return detected
  }
  return {
    ...detected,
    visible: true,
    ownership: detected.ownership === 'orca-managed' ? 'orca-managed' : 'unknown-legacy'
  }
}

/** The deleted twin's body, verbatim. */
export function legacyAreRuntimePathsEqual(leftPath: string, rightPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(leftPath) === normalizeRuntimePathForComparison(rightPath)
  )
}

function hasStrongOrcaMetadata(meta: WorktreeMeta | undefined): boolean {
  return Boolean(
    meta?.orcaCreatedAt ||
    meta?.orcaCreationWorkspaceLayout ||
    meta?.createdAt ||
    meta?.createdWithAgent ||
    meta?.pushTarget ||
    meta?.sparseBaseRef ||
    meta?.sparsePresetId ||
    meta?.preserveBranchOnDelete
  )
}

function isUnderFlatOrUntrustedOrcaRoot(
  worktreePath: string,
  knownOrcaLayouts: OrcaWorkspaceLayout[]
): boolean {
  for (const layout of knownOrcaLayouts) {
    const relative = relativePathInsideRoot(layout.path, worktreePath)
    if (relative === null) {
      continue
    }
    if (!layout.nestWorkspaces) {
      return true
    }
  }
  return false
}

function canClassifyAsExternal(
  worktreePath: string,
  knownOrcaLayouts: OrcaWorkspaceLayout[]
): boolean {
  if (knownOrcaLayouts.length === 0) {
    return false
  }
  for (const layout of knownOrcaLayouts) {
    const relative = relativePathInsideRoot(layout.path, worktreePath)
    if (relative === null) {
      continue
    }
    return layout.nestWorkspaces
  }
  return true
}
