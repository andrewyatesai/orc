import { toast } from 'sonner'
import type {
  BundledSkillInstallOutcome,
  BundledSkillInstallResult
} from '../../../shared/bundled-skill-install'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { AGENT_SKILL_CLI_PREREQUISITE_NOTICE } from '@/lib/agent-skill-cli-prerequisite'
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
  toast.error(
    translate(
      'auto.lib.bundled.skill.offline.install.failed',
      'Could not install {{value0}} from this app build.',
      { value0 }
    ),
    { description }
  )
}

function userOwnedCopyPath(result: BundledSkillInstallResult): string | null {
  return (
    result.placements.find(
      (placement) =>
        placement.state === 'refused-unrecognized' || placement.state === 'refused-unsafe-topology'
    )?.packagePath ?? null
  )
}

// Why: the terminal rail's command is `npx skills add --global`, the one thing that
// would overwrite the copy we just declined to touch. Point at the user's own file
// instead of handing them the clobber as the obvious next click.
function reportKeptUserCopy(result: BundledSkillInstallResult, skillLabel: string): void {
  const packagePath = userOwnedCopyPath(result)
  toast.warning(
    translate(
      'auto.lib.bundled.skill.offline.install.refusedUserOwned',
      'Orca kept your own copy of {{value0}}.',
      { value0: skillLabel }
    ),
    {
      description: packagePath
        ? translate(
            'auto.lib.bundled.skill.offline.install.refusedUserOwnedKeptAt',
            'Nothing was overwritten. Your copy at {{value0}} stays in charge until you move it aside.',
            { value0: packagePath }
          )
        : translate(
            'auto.lib.bundled.skill.offline.install.refusedUserOwnedKept',
            'Nothing was overwritten. Your copy stays in charge until you move it aside.'
          ),
      action: packagePath
        ? {
            label: translate('auto.lib.bundled.skill.offline.install.showMyCopy', 'Show my copy'),
            onClick: () => {
              void window.api.shell.openInFileManager(packagePath).catch(() => undefined)
            }
          }
        : undefined
    }
  )
}

export type BundledSkillOfflineInstallOutcome = {
  /** The bundled bytes are on disk — installed now, or already current. */
  installed: boolean
  /** Orca refused to touch a copy the user owns; nothing was overwritten. */
  keptUserCopy: boolean
}

/**
 * Install shipped skill packages straight from the app bundle, reporting as it goes.
 *
 * Callers that only need "did this converge" want `installBundledSkillsOffline`. The
 * refusal is separate because it is the one stop-short a terminal must not answer:
 * the command that rail preloads overwrites exactly the copy we refused to touch.
 */
export async function runBundledSkillOfflineInstall(args: {
  names: readonly string[]
  skillLabel: string
}): Promise<BundledSkillOfflineInstallOutcome> {
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
    return { installed: false, keptUserCopy: false }
  }

  const summary = summarizeBundledSkillInstall(results)
  if (!summary) {
    return { installed: false, keptUserCopy: false }
  }
  if (isBundledSkillInstallComplete(summary.outcome)) {
    // Why: detection is cached per target, so the banner only clears once the
    // discovery and freshness scans are told the bytes on disk changed.
    notifyInstalledAgentSkillsChanged()
    reportComplete(summary.outcome, args.skillLabel)
    return { installed: true, keptUserCopy: false }
  }
  if (summary.outcome === 'refused-user-owned') {
    console.warn('[skills] offline install kept a user-owned copy:', summary.reason)
    reportKeptUserCopy(summary, args.skillLabel)
    return { installed: false, keptUserCopy: true }
  }
  console.warn('[skills] offline install fell back to a terminal:', summary.outcome, summary.reason)
  reportTerminalFallback(summary, args.skillLabel)
  return { installed: false, keptUserCopy: false }
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
  return (await runBundledSkillOfflineInstall(args)).installed
}

/**
 * Whether the shipped payload can reach the skill home this surface installs into.
 *
 * Main writes the bundled bytes into this machine's agent homes only, so a WSL distro
 * or a runtime Orca cannot install to keeps the terminal rail that reaches it. A
 * remote runtime is refused in main as well, which lands the caller on the same rail.
 */
export function isBundledSkillOfflineInstallSupported(runtime: {
  agentRuntime?: { runtime: 'host' | 'wsl' } | null
  installDisabledReason?: string | null
}): boolean {
  return !runtime.installDisabledReason && (runtime.agentRuntime?.runtime ?? 'host') === 'host'
}

/** Registering `orca` on PATH is a separate step the offline write cannot perform. */
export function bundledSkillOfflineInstallCliNotice(): string {
  return translate(
    'auto.lib.bundled.skill.offline.install.cliStillNeeded',
    'The skill installs from this app build — no network. Registering the Orca CLI on PATH still needs the setup terminal.'
  )
}

export type BundledSkillOfflineInstallTarget = {
  supported: boolean
  names: readonly string[]
  skillLabel: string
  onBeforeInstall?: () => void
  onInstalled?: () => void | Promise<unknown>
}

/**
 * The `offlineInstall` handler for a setup panel, or undefined to keep its terminal.
 *
 * Every bundled-skill CTA needs the same three beats — record the interaction, write
 * the payload, re-check the surface — so they share one factory rather than each
 * growing its own copy that can drift from the panel's true/false contract.
 */
export function buildBundledSkillOfflineInstall(
  args: BundledSkillOfflineInstallTarget
): (() => Promise<boolean>) | undefined {
  if (!args.supported) {
    return undefined
  }
  return async () => {
    args.onBeforeInstall?.()
    const outcome = await runBundledSkillOfflineInstall({
      names: args.names,
      skillLabel: args.skillLabel
    })
    if (outcome.installed) {
      await args.onInstalled?.()
    }
    // Why: true means "no terminal", not "we wrote something" — the terminal this
    // would open preloads the command that overwrites the copy we just kept.
    return outcome.installed || outcome.keptUserCopy
  }
}

/**
 * The notice/handler pair a setup panel needs to offer the offline rail.
 *
 * They always move together — the notice describes exactly what the handler will and
 * will not do — so the CTAs spread this rather than each re-deriving the pairing and
 * risking a panel that promises a terminal step its button never takes.
 */
export function bundledSkillOfflineInstallPanelProps(target: BundledSkillOfflineInstallTarget): {
  preInstallNotice: string
  offlineInstall?: () => Promise<boolean>
} {
  return {
    preInstallNotice: target.supported
      ? bundledSkillOfflineInstallCliNotice()
      : AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
    offlineInstall: buildBundledSkillOfflineInstall(target)
  }
}
