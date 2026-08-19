import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  SkillCurrentBundleEntry,
  SkillInstallationTopology,
  SkillKnownSnapshot
} from '../../shared/skill-freshness'
import type { SkillBundleArtifacts } from './skill-bundle-artifacts'
import type { SkillScanRoot } from './skill-discovery-sources'
import { classifyHomeSkillTopology } from './skill-installation-topology'
import { matchingKnownSnapshot, observeSkillPackage } from './skill-package-identity'

export type BundledSkillTargetState =
  | 'absent'
  | 'ours-current'
  | 'ours-older'
  | 'ours-newer'
  | 'unrecognized'
  | 'unsafe-topology'

export type BundledSkillTargetClassification = {
  state: BundledSkillTargetState
  /** Where the bytes actually live; the dedupe key across provider aliases. */
  resolvedPath: string | null
  detail: string | null
}

// Why: the write is a directory swap. Anything reached through a link, or that the
// process cannot rewrite, is a placement the user arranged and we would be undoing.
const REPLACEABLE_TOPOLOGIES: ReadonlySet<SkillInstallationTopology> = new Set([
  'canonical-copy',
  'independent-copy'
])

function knownSnapshots(
  artifacts: SkillBundleArtifacts,
  entry: SkillCurrentBundleEntry
): SkillKnownSnapshot[] {
  const snapshots = artifacts.knownSnapshots[entry.name] ?? []
  // An unreleased current revision is absent from the registry but is still ours.
  return snapshots.some((snapshot) => snapshot.packageDigest === entry.packageDigest)
    ? snapshots
    : [...snapshots, entry]
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Where the package will live, canonical even before anything on the way there exists.
 *
 * A first install creates the skills root itself, so resolving only what is already
 * there would hand back an unresolved path that realpath answers differently the
 * moment our own mkdir runs — and the swap guard reads that change as a takeover.
 */
async function projectedPackagePath(rootPath: string, name: string): Promise<string> {
  const missing: string[] = [name]
  let current = resolve(rootPath)
  for (;;) {
    const resolved = await realpath(current).catch(() => null)
    if (resolved) {
      return join(resolved, ...missing)
    }
    const parent = dirname(current)
    if (parent === current) {
      return join(resolve(rootPath), name)
    }
    missing.unshift(basename(current))
    current = parent
  }
}

/**
 * Decide what an offline install may do to one target package directory.
 *
 * Only `absent` and `ours-older` authorise a write. `unrecognized` is content this
 * build cannot account for — a user edit, a fork, a package from another source —
 * and overwriting it is the one mistake an automatic writer cannot apologise for.
 * `ours-newer` is official content ahead of us, so writing would be a downgrade.
 */
export async function classifyBundledSkillTarget(args: {
  root: SkillScanRoot
  entry: SkillCurrentBundleEntry
  artifacts: SkillBundleArtifacts
  canonicalRootPath: string
}): Promise<BundledSkillTargetClassification> {
  const packagePath = join(args.root.path, args.entry.name)
  try {
    await lstat(packagePath)
  } catch (error) {
    // Nothing is there to preserve, so the topology gate below has no work: a user
    // who symlinked their skills root asked for new skills to land where it points.
    if (isMissing(error)) {
      return {
        state: 'absent',
        resolvedPath: await projectedPackagePath(args.root.path, args.entry.name),
        detail: null
      }
    }
    return { state: 'unsafe-topology', resolvedPath: null, detail: describe(error, 'lstat-failed') }
  }

  const topology = await classifyHomeSkillTopology(
    args.root,
    packagePath,
    args.canonicalRootPath
  ).catch((error: unknown) => ({
    topology: 'broken-link' as const,
    resolvedPath: null,
    identity: null,
    errorCategory: describe(error, 'topology-failed')
  }))
  if (!topology.resolvedPath || !REPLACEABLE_TOPOLOGIES.has(topology.topology)) {
    return {
      state: 'unsafe-topology',
      resolvedPath: topology.resolvedPath,
      detail: topology.errorCategory
        ? `${topology.topology}: ${topology.errorCategory}`
        : topology.topology
    }
  }

  try {
    const observed = await observeSkillPackage(topology.resolvedPath)
    // Why: a later release can reintroduce identical bytes, so exact current
    // identity wins over whichever snapshot the search happens to match.
    const snapshot =
      observed.observedDigest === args.entry.packageDigest
        ? args.entry
        : matchingKnownSnapshot(observed, knownSnapshots(args.artifacts, args.entry))
    if (!snapshot) {
      return {
        state: 'unrecognized',
        resolvedPath: topology.resolvedPath,
        detail: observed.observedDigest
      }
    }
    if (snapshot.packageDigest === args.entry.packageDigest) {
      return { state: 'ours-current', resolvedPath: topology.resolvedPath, detail: null }
    }
    return {
      state: snapshot.releaseRevision > args.entry.releaseRevision ? 'ours-newer' : 'ours-older',
      resolvedPath: topology.resolvedPath,
      detail: null
    }
  } catch (error) {
    // A package we cannot even read is not one we may replace.
    return {
      state: 'unrecognized',
      resolvedPath: topology.resolvedPath,
      detail: describe(error, 'skill-package-read-failed')
    }
  }
}
