import {
  SUPPORTED_BUNDLED_SKILL_TOPOLOGIES,
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInstallation
} from '../../shared/skill-freshness'

/** Which updater owns a name: the npx runner, or this build's own payload. */
export type SkillUpdateRail = 'npx' | 'bundled'

export type SkillUpdateEligibility = {
  /** Every name Orca can converge, on either rail. */
  names: string[]
  /** The subset the offline installer writes; the rest belong to the npx runner. */
  offlineNames: string[]
}

/**
 * Names an update Orca offers can actually converge, and which rail owns each.
 *
 * Eligibility is decided purely over the placements the update touches — the
 * canonical copy and its symlink aliases. Copies it provably leaves alone (standalone
 * duplicates, project skills, plugin caches, links out of tree) neither authorize an
 * update nor withhold one: the badge would otherwise promise work the update cannot
 * do, or refuse work it could, over a copy that is never at stake either way. A
 * blocked *convergent* copy still withholds it, because that is the placement the
 * update would write to and overwriting it is the real data-loss case.
 *
 * Two rails answer for a name, and they must not trade places. `globallyUpdatableNames`
 * comes from the npx updater's lock, which is the only thing `skills update` consults;
 * `offlineConvergableNames` are the ones this build ships bytes for and can write
 * itself. The npx rail wins wherever both could claim a name — writing under that
 * lock leaves it pointing at content the command can no longer reach. Callers pass an
 * offline set already stripped of locked names for the same reason.
 *
 * Without the offline rail a copy installed from the bundle was a dead end: no lock
 * entry meant no eligibility, so a later build shipping newer bytes turned the pill
 * amber with nothing on offer to clear it.
 */
export function eligibleSkillUpdates(
  installations: readonly SkillFreshnessInstallation[],
  globallyUpdatableNames: ReadonlySet<string>,
  offlineConvergableNames: ReadonlySet<string> = new Set()
): SkillUpdateEligibility {
  const byName = new Map<string, SkillFreshnessInstallation[]>()
  for (const installation of installations) {
    const entries = byName.get(installation.name) ?? []
    entries.push(installation)
    byName.set(installation.name, entries)
  }

  const names: string[] = []
  const offlineNames: string[] = []
  for (const [name, entries] of byName) {
    const rail: SkillUpdateRail | null = globallyUpdatableNames.has(name)
      ? 'npx'
      : offlineConvergableNames.has(name)
        ? 'bundled'
        : null
    if (!rail) {
      continue
    }
    // Why: each rail answers for the placements ITS updater writes. The bundled
    // installer writes provider homes directly, so `independent-copy` is convergent
    // for it and a dead end for npx.
    const supported =
      rail === 'bundled' ? SUPPORTED_BUNDLED_SKILL_TOPOLOGIES : SUPPORTED_GLOBAL_SKILL_TOPOLOGIES
    const convergent = entries.filter((entry) => supported.has(entry.topology))
    // Why: without a convergent placement the update has no anchor, so it would
    // no-op or error against a canonical install that isn't there.
    if (convergent.length === 0) {
      continue
    }
    const hasOutdated = convergent.some((entry) => entry.status === 'outdated')
    const everyConvergentCopyIsSafeToWrite = convergent.every(
      (entry) =>
        (entry.status === 'current' || entry.status === 'outdated') &&
        Boolean(entry.resolvedPath && entry.physicalIdentity)
    )
    if (hasOutdated && everyConvergentCopyIsSafeToWrite) {
      names.push(name)
      if (rail === 'bundled') {
        offlineNames.push(name)
      }
    }
  }
  const byLocale = (left: string, right: string): number => left.localeCompare(right, 'en')
  return { names: names.sort(byLocale), offlineNames: offlineNames.sort(byLocale) }
}
