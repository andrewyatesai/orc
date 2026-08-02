import { toast } from 'sonner'
import type {
  BundledSkillInstallOutcome,
  BundledSkillInstallResult
} from '../../../shared/bundled-skill-install'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { translate } from '@/i18n/i18n'

// Why: mirrors the main-process precedence — the reported outcome is the one that
// still needs a human, so a refusal for one name is never hidden by a sibling write.
const OUTCOME_PRECEDENCE: readonly BundledSkillInstallOutcome[] = [
  'failed',
  'bundle-corrupt',
  'refused-user-owned',
  'deferred-to-npx',
  'updated',
  'installed',
  'already-current'
]

export function summarizeBundledSkillInstall(
  results: readonly BundledSkillInstallResult[]
): BundledSkillInstallResult | null {
  for (const outcome of OUTCOME_PRECEDENCE) {
    const match = results.find((result) => result.outcome === outcome)
    if (match) {
      return match
    }
  }
  return null
}

export function isBundledSkillInstallComplete(outcome: BundledSkillInstallOutcome): boolean {
  return outcome === 'installed' || outcome === 'updated' || outcome === 'already-current'
}

function reportComplete(outcome: BundledSkillInstallOutcome, skillLabel: string): void {
  const value0 = skillLabel
  if (outcome === 'installed') {
    toast.success(
      translate(
        'auto.lib.bundled.skill.offline.install.installed',
        'Installed {{value0}} from this app build.',
        { value0 }
      )
    )
    return
  }
  if (outcome === 'updated') {
    toast.success(
      translate(
        'auto.lib.bundled.skill.offline.install.updated',
        'Updated {{value0}} from this app build.',
        { value0 }
      )
    )
    return
  }
  toast.success(
    translate(
      'auto.lib.bundled.skill.offline.install.alreadyCurrent',
      'No update needed for {{value0}}.',
      { value0 }
    )
  )
}

function reportTerminalFallback(result: BundledSkillInstallResult, skillLabel: string): void {
  const value0 = skillLabel
  const description = translate(
    'auto.lib.bundled.skill.offline.install.openingTerminal',
    'Opening a terminal to finish the install.'
  )
  if (result.outcome === 'deferred-to-npx') {
    toast.info(
      translate(
        'auto.lib.bundled.skill.offline.install.deferredToNpx',
        'The skills CLI manages {{value0}}.',
        { value0 }
      ),
      { description }
    )
    return
  }
  if (result.outcome === 'refused-user-owned') {
    toast.warning(
      translate(
        'auto.lib.bundled.skill.offline.install.refusedUserOwned',
        'Orca kept your own copy of {{value0}}.',
        { value0 }
      ),
      {
        description: translate(
          'auto.lib.bundled.skill.offline.install.refusedUserOwnedDescription',
          'Nothing was overwritten. Opening a terminal so you can decide.'
        )
      }
    )
    return
  }
  toast.error(
    translate(
      'auto.lib.bundled.skill.offline.install.failed',
      'Could not install {{value0}} from this app build.',
      { value0 }
    ),
    { description }
  )
}

/**
 * Install shipped skill packages straight from the app bundle.
 *
 * Returns true when the skill is in place and no terminal is needed. False means the
 * offline path stopped short — a name the npx updater owns, a copy the user changed,
 * or a failure — and the caller should fall back to its command terminal.
 */
export async function installBundledSkillsOffline(args: {
  names: readonly string[]
  skillLabel: string
}): Promise<boolean> {
  let results: BundledSkillInstallResult[]
  try {
    results = await window.api.skills.installBundled([...args.names])
  } catch (error) {
    toast.error(
      translate(
        'auto.lib.bundled.skill.offline.install.failed',
        'Could not install {{value0}} from this app build.',
        { value0: args.skillLabel }
      ),
      {
        description:
          error instanceof Error
            ? error.message
            : translate(
                'auto.lib.bundled.skill.offline.install.openingTerminal',
                'Opening a terminal to finish the install.'
              )
      }
    )
    return false
  }

  const summary = summarizeBundledSkillInstall(results)
  if (!summary) {
    return false
  }
  if (isBundledSkillInstallComplete(summary.outcome)) {
    // Why: detection is cached per target, so the banner only clears once the
    // discovery and freshness scans are told the bytes on disk changed.
    notifyInstalledAgentSkillsChanged()
    reportComplete(summary.outcome, args.skillLabel)
    return true
  }
  console.warn('[skills] offline install fell back to a terminal:', summary.outcome, summary.reason)
  reportTerminalFallback(summary, args.skillLabel)
  return false
}
