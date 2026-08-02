import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildSkillDiscoverySources, type SkillScanRoot } from './skill-discovery-sources'

export const CANONICAL_AGENT_SKILLS_ROOT_ID = 'home-agents'

function homeSkillRoots(homeDir?: string): SkillScanRoot[] {
  return buildSkillDiscoverySources({ homeDir, includeCwd: false }).filter(
    (root) => root.sourceKind === 'home'
  )
}

export function canonicalAgentSkillsRootPath(homeDir?: string): string {
  const canonical = homeSkillRoots(homeDir).find(
    (root) => root.id === CANONICAL_AGENT_SKILLS_ROOT_ID
  )
  if (!canonical) {
    throw new Error('Missing canonical agent skills root')
  }
  return canonical.path
}

async function isExistingDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false
  )
}

/**
 * The agent skill homes an offline install may write into.
 *
 * An agent's own config directory is the only evidence the user runs it, and it is
 * never ours to create: materialising `~/.codex` for someone who has no Codex
 * invents a configuration the app does not own and no agent asked for. The skills
 * directory inside a config directory that already exists is a different matter —
 * that is the folder the agent reads, and creating it is the install.
 *
 * The canonical cross-agent root sorts first so provider symlinks pointing into it
 * resolve to a placement this run has already handled.
 */
export async function detectBundledSkillInstallRoots(
  args: { homeDir?: string } = {}
): Promise<SkillScanRoot[]> {
  const detected = await Promise.all(
    homeSkillRoots(args.homeDir).map(async (root) =>
      (await isExistingDirectory(dirname(root.path))) ? root : null
    )
  )
  return detected
    .filter((root): root is SkillScanRoot => root !== null)
    .sort(
      (left, right) =>
        Number(right.id === CANONICAL_AGENT_SKILLS_ROOT_ID) -
        Number(left.id === CANONICAL_AGENT_SKILLS_ROOT_ID)
    )
}
