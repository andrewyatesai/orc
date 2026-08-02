import type {
  BundledSkillInstallOutcome,
  BundledSkillInstallResult,
  BundledSkillPlacementResult,
  BundledSkillPlacementState
} from '../../shared/bundled-skill-install'
import { loadSkillBundleArtifacts, type SkillBundleArtifacts } from './skill-bundle-artifacts'
import type { SkillScanRoot } from './skill-discovery-sources'
import { normalizedSkillIdentityPath } from './skill-installation-topology'
import { readGloballyUpdatableSkillLocks } from './skill-update-registration'
import {
  canonicalAgentSkillsRootPath,
  detectBundledSkillInstallRoots
} from './bundled-skill-install-targets'
import { writeSkillPackageAtomically } from './bundled-skill-package-write'
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
  payload: Extract<BundledSkillPayload, { verified: true }>
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
        await writeSkillPackageAtomically(packagePath, payload.files)
        return placementFor(
          root,
          classification,
          classification.state === 'absent' ? 'installed' : 'updated',
          packagePath
        )
      } catch (error) {
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

async function installOneBundledSkill(args: {
  name: string
  roots: readonly SkillScanRoot[]
  canonicalRootPath: string
  artifacts: SkillBundleArtifacts
  resourceRoot?: string
}): Promise<BundledSkillInstallResult> {
  const payload = await readBundledSkillPayload({
    name: args.name,
    artifacts: args.artifacts,
    resourceRoot: args.resourceRoot
  })
  if (!payload.verified) {
    return {
      name: args.name,
      // An unknown name is a caller mistake; anything else means the shipped bytes
      // do not match what the manifest hashed, and none of them may be installed.
      outcome: payload.failure === 'unknown-skill' ? 'failed' : 'bundle-corrupt',
      reason: `${payload.failure}: ${payload.detail}`,
      placements: []
    }
  }
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
    const classification = await classifyBundledSkillTarget({
      root,
      entry: payload.entry,
      artifacts: args.artifacts,
      canonicalRootPath: args.canonicalRootPath
    })
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
    const placement = await applyClassification(root, classification, payload)
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
 */
export async function installBundledSkills(
  args: BundledSkillInstallArgs
): Promise<BundledSkillInstallResult[]> {
  const names = [...new Set(args.names)]
  const [artifacts, locks, roots] = await Promise.all([
    // Why: the caller gets an outcome per name, never an exception — damaged
    // resources are a fact about this install, not a reason to lose the report.
    loadSkillBundleArtifacts(args.resourceRoot).catch((error: unknown) =>
      error instanceof Error ? error : new Error('skill-bundle-unreadable')
    ),
    readGloballyUpdatableSkillLocks({ homeDir: args.homeDir, stateHome: args.stateHome }),
    detectBundledSkillInstallRoots({ homeDir: args.homeDir })
  ])
  if (artifacts instanceof Error) {
    return names.map((name) => ({
      name,
      outcome: 'bundle-corrupt',
      reason: artifacts.message,
      placements: []
    }))
  }
  const canonicalRootPath = canonicalAgentSkillsRootPath(args.homeDir)

  const results: BundledSkillInstallResult[] = []
  for (const name of names) {
    if (locks.has(name)) {
      results.push({ name, outcome: 'deferred-to-npx', reason: null, placements: [] })
      continue
    }
    // Sequential on purpose: two names can share a skills root, and the swap
    // renames sibling scratch directories inside it.
    results.push(
      await installOneBundledSkill({
        name,
        roots,
        canonicalRootPath,
        artifacts,
        resourceRoot: args.resourceRoot
      })
    )
  }
  return results
}
