import type {
  BundledSkillInstallOutcome,
  BundledSkillInstallResult,
  BundledSkillPlacementResult,
  BundledSkillPlacementState
} from '../../shared/bundled-skill-install'
import { loadSkillBundleArtifacts, type SkillBundleArtifacts } from './skill-bundle-artifacts'
import type { SkillScanRoot } from './skill-discovery-sources'
import { normalizedSkillIdentityPath } from './skill-installation-topology'
import { readGloballyUpdatableSkillLockState } from './skill-update-registration'
import {
  canonicalAgentSkillsRootPath,
  detectBundledSkillInstallRoots
} from './bundled-skill-install-targets'
import {
  bundledSkillSwapGuard,
  SkillPackageSwapRefused,
  writeSkillPackageAtomically
} from './bundled-skill-package-write'
import { recoverInterruptedSkillPackageSwaps } from './bundled-skill-swap-recovery'
import { readBundledSkillPayload, type BundledSkillPayload } from './bundled-skill-payload'
import {
  classifyBundledSkillTarget,
  type BundledSkillTargetClassification
} from './bundled-skill-target-classification'

// The outcome vocabulary lives in shared/ because the renderer reads it over IPC.
export type {
  BundledSkillInstallOutcome,
  BundledSkillInstallResult,
  BundledSkillPlacementResult,
  BundledSkillPlacementState
}

export type BundledSkillInstallArgs = {
  names: readonly string[]
  homeDir?: string
  resourceRoot?: string
  stateHome?: string | null
}

function placementFor(
  root: SkillScanRoot,
  classification: BundledSkillTargetClassification,
  state: BundledSkillPlacementState,
  packagePath: string
): BundledSkillPlacementResult {
  return {
    rootId: root.id,
    sourceLabel: root.label,
    packagePath,
    state,
    detail: classification.detail
  }
}

async function applyClassification(
  root: SkillScanRoot,
  classification: BundledSkillTargetClassification,
  payload: Extract<BundledSkillPayload, { verified: true }>,
  revalidate: () => Promise<string | null>
): Promise<BundledSkillPlacementResult> {
  const packagePath = classification.resolvedPath ?? root.path
  switch (classification.state) {
    case 'unsafe-topology':
      return placementFor(root, classification, 'refused-unsafe-topology', packagePath)
    case 'unrecognized':
      return placementFor(root, classification, 'refused-unrecognized', packagePath)
    case 'ours-current':
    case 'ours-newer':
      return placementFor(root, classification, 'already-current', packagePath)
    case 'absent':
    case 'ours-older':
      try {
        await writeSkillPackageAtomically(packagePath, payload.files, { revalidate })
        return placementFor(
          root,
          classification,
          classification.state === 'absent' ? 'installed' : 'updated',
          packagePath
        )
      } catch (error) {
        // Something claimed the destination after classification: the same refusal
        // it would have earned had it been there when we looked.
        if (error instanceof SkillPackageSwapRefused) {
          return {
            ...placementFor(root, classification, 'refused-unrecognized', packagePath),
            detail: error.message
          }
        }
        return {
          ...placementFor(root, classification, 'failed', packagePath),
          detail: error instanceof Error ? error.message : 'skill-package-write-failed'
        }
      }
  }
}

// Why: the outcome names what still needs a human. A refusal outranks a successful
// write because the untouched copy is the part the user has to decide about; the
// placement list keeps every write visible underneath it.
function summarize(placements: readonly BundledSkillPlacementResult[]): {
  outcome: BundledSkillInstallOutcome
  reason: string | null
} {
  const firstOf = (...states: BundledSkillPlacementState[]): BundledSkillPlacementResult | null =>
    placements.find((placement) => states.includes(placement.state)) ?? null
  const failed = firstOf('failed')
  if (failed) {
    return { outcome: 'failed', reason: failed.detail ?? 'skill-package-write-failed' }
  }
  const refused = firstOf('refused-unrecognized', 'refused-unsafe-topology')
  if (refused) {
    return { outcome: 'refused-user-owned', reason: `${refused.state}: ${refused.detail ?? ''}` }
  }
  if (firstOf('updated')) {
    return { outcome: 'updated', reason: null }
  }
  return { outcome: firstOf('installed') ? 'installed' : 'already-current', reason: null }
}

function rejectedPayloadResult(
  name: string,
  payload: Extract<BundledSkillPayload, { verified: false }>
): BundledSkillInstallResult {
  return {
    name,
    // An unknown name is a caller mistake; anything else means the shipped bytes
    // do not match what the manifest hashed, and none of them may be installed.
    outcome: payload.failure === 'unknown-skill' ? 'failed' : 'bundle-corrupt',
    reason: `${payload.failure}: ${payload.detail}`,
    placements: []
  }
}

async function installOneBundledSkill(args: {
  name: string
  payload: Extract<BundledSkillPayload, { verified: true }>
  roots: readonly SkillScanRoot[]
  canonicalRootPath: string
  artifacts: SkillBundleArtifacts
  lockArgs: { homeDir?: string; stateHome?: string | null }
}): Promise<BundledSkillInstallResult> {
  const { payload } = args
  if (args.roots.length === 0) {
    return {
      name: args.name,
      outcome: 'failed',
      reason: 'no-detected-agent-home',
      placements: []
    }
  }

  const placements: BundledSkillPlacementResult[] = []
  const handledByPath = new Map<string, BundledSkillPlacementResult>()
  for (const root of args.roots) {
    const classifyArgs = {
      root,
      entry: payload.entry,
      artifacts: args.artifacts,
      canonicalRootPath: args.canonicalRootPath
    }
    const classification = await classifyBundledSkillTarget(classifyArgs)
    // Why: a provider alias, or a skills root symlinked to another, resolves to a
    // directory this run may already have written. Reporting it as a refusal would
    // invent a conflict with content we just installed.
    const key = classification.resolvedPath
      ? normalizedSkillIdentityPath(classification.resolvedPath)
      : null
    const handled = key ? handledByPath.get(key) : null
    if (handled) {
      placements.push({
        rootId: root.id,
        sourceLabel: root.label,
        packagePath: handled.packagePath,
        state: 'alias',
        detail: handled.state
      })
      continue
    }
    const placement = await applyClassification(
      root,
      classification,
      payload,
      bundledSkillSwapGuard({
        name: args.name,
        expected: classification,
        reclassify: () => classifyBundledSkillTarget(classifyArgs),
        relock: () => readGloballyUpdatableSkillLockState(args.lockArgs)
      })
    )
    if (key) {
      handledByPath.set(key, placement)
    }
    placements.push(placement)
  }
  return { name: args.name, ...summarize(placements), placements }
}

/**
 * Install shipped skill packages from the app bundle, without network or npx.
 *
 * Names the npx updater has a lock entry for are handed back untouched. That lock
 * is the only thing `skills update` consults — it never reads disk — so writing
 * different bytes underneath one leaves the name eligible while the command it
 * feeds can only no-op: the user is offered an update that reports success and
 * changes nothing, forever. Deferring costs one skill the offline path and keeps
 * the rail that already owns it coherent.
 *
 * The whole batch is verified before anything is written, because a rejection
 * halfway through cannot unwrite the names already swapped in.
 */
export async function installBundledSkills(
  args: BundledSkillInstallArgs
): Promise<BundledSkillInstallResult[]> {
  const names = [...new Set(args.names)]
  const lockArgs = { homeDir: args.homeDir, stateHome: args.stateHome }
  const [artifacts, lock, roots] = await Promise.all([
    // Why: the caller gets an outcome per name, never an exception — damaged
    // resources are a fact about this install, not a reason to lose the report.
    loadSkillBundleArtifacts(args.resourceRoot).catch((error: unknown) =>
      error instanceof Error ? error : new Error('skill-bundle-unreadable')
    ),
    readGloballyUpdatableSkillLockState(lockArgs),
    detectBundledSkillInstallRoots({ homeDir: args.homeDir })
  ])
  // Why: a swap a dead process left half-applied hides the package under scratch, so
  // classification would read the destination as free. Put it back before we look.
  await Promise.all(roots.map((root) => recoverInterruptedSkillPackageSwaps(root.path)))
  if (artifacts instanceof Error) {
    return names.map((name) => ({
      name,
      outcome: 'bundle-corrupt',
      reason: artifacts.message,
      placements: []
    }))
  }
  // Why: a lock we cannot read is not an absent one. The entries we would have to
  // respect are precisely the ones hidden by the failure, so every name defers.
  if (lock.status === 'unreadable') {
    return names.map((name) => ({
      name,
      outcome: 'deferred-to-npx',
      reason: `unreadable-skill-lock: ${lock.detail}`,
      placements: []
    }))
  }
  const canonicalRootPath = canonicalAgentSkillsRootPath(args.homeDir)

  const payloads = new Map<string, BundledSkillPayload>()
  for (const name of names.filter((candidate) => !lock.locks.has(candidate))) {
    payloads.set(
      name,
      await readBundledSkillPayload({ name, artifacts, resourceRoot: args.resourceRoot })
    )
  }
  // A caller's typo fails only its own name; damaged bytes condemn the batch.
  const corrupt = [...payloads].find(
    ([, payload]) => !payload.verified && payload.failure !== 'unknown-skill'
  )

  const results: BundledSkillInstallResult[] = []
  for (const name of names) {
    const payload = payloads.get(name)
    // A name held back from verification is one the npx lock already owns.
    if (!payload) {
      results.push({ name, outcome: 'deferred-to-npx', reason: null, placements: [] })
      continue
    }
    if (!payload.verified) {
      results.push(rejectedPayloadResult(name, payload))
      continue
    }
    if (corrupt) {
      results.push({
        name,
        outcome: 'bundle-corrupt',
        reason: `blocked-by-corrupt-bundle: ${corrupt[0]}`,
        placements: []
      })
      continue
    }
    // Sequential on purpose: two names can share a skills root, and the swap
    // renames sibling scratch directories inside it.
    results.push(
      await installOneBundledSkill({ name, payload, roots, canonicalRootPath, artifacts, lockArgs })
    )
  }
  return results
}
