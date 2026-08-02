// Outcome vocabulary for installing skill packages shipped inside the app bundle.
// Shared because the renderer decides from these whether a terminal is still needed.

export type BundledSkillInstallOutcome =
  | 'installed'
  | 'already-current'
  | 'updated'
  | 'deferred-to-npx'
  | 'refused-user-owned'
  | 'bundle-corrupt'
  | 'failed'

export type BundledSkillPlacementState =
  | 'installed'
  | 'updated'
  | 'already-current'
  | 'alias'
  | 'refused-unrecognized'
  | 'refused-unsafe-topology'
  | 'failed'

export type BundledSkillPlacementResult = {
  rootId: string
  sourceLabel: string
  packagePath: string
  state: BundledSkillPlacementState
  detail: string | null
}

export type BundledSkillInstallResult = {
  name: string
  outcome: BundledSkillInstallOutcome
  reason: string | null
  placements: BundledSkillPlacementResult[]
}
