import { AlertTriangle, CheckCircle2, Copy } from 'lucide-react'
import type { SkillUpdateRun } from '../../../../shared/skill-freshness'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { OfflineSkillUpdateRun } from './skill-offline-update-run'

export type SkillUpdateCombinedOutcome = {
  /** Every rail this press handed work to has reported, so there is a result to show. */
  settled: boolean
  /** Names taken on across both rails. */
  attemptedNames: string[]
  /** Still outdated after `skills update` — only that rail can retry them. */
  failedNpxNames: string[]
  /** Refused or unwritable by the bundled installer — only it can retry them. */
  failedOfflineNames: string[]
  /**
   * Either rail stopped short.
   *
   * Not `failedNames.length > 0`: `skills update` can exit non-zero with every name
   * converged, and that still has a message the user has to read.
   */
  failed: boolean
}

/**
 * Rails this press handed work to, recorded by whoever split the batch.
 *
 * A rail is dispatched before it can report — `skills update` reaches `running`
 * only once main pushes it — and an idle run reads exactly like one that was
 * never asked. Without this record the rail that finishes first names the
 * outcome of work the other rail has not started yet. Retire it with the result.
 */
export type SkillUpdateRailsDispatched = { npx?: boolean; offline?: boolean }

/** Never took work | owes a report | has reported. */
type SkillUpdateRailPhase = 'idle' | 'working' | 'settled'

function railPhase(settled: boolean, running: boolean, dispatched: boolean): SkillUpdateRailPhase {
  if (settled) {
    return 'settled'
  }
  return running || dispatched ? 'working' : 'idle'
}

/**
 * One result for one press of Update, however many rails served it.
 *
 * The rails start together and settle independently, so reading either alone
 * announces an outcome the other can contradict — a refused bundled write under
 * an npx "Updated 2 skills" is the success nobody looks past.
 */
export function combineSkillUpdateOutcome(
  npxRun: SkillUpdateRun,
  offlineRun: OfflineSkillUpdateRun,
  dispatched: SkillUpdateRailsDispatched = {}
): SkillUpdateCombinedOutcome {
  const npxSettled = npxRun.state === 'success' || npxRun.state === 'error'
  const offlineSettled = !offlineRun.running && offlineRun.names.length > 0
  const npxPhase = railPhase(npxSettled, npxRun.state === 'running', dispatched.npx === true)
  const offlinePhase = railPhase(offlineSettled, offlineRun.running, dispatched.offline === true)
  const failedOfflineNames = offlineSettled ? [...offlineRun.failedNames] : []
  return {
    // Every rail that took work reports before anything is announced — but a press
    // is free to use one rail, so an untouched rail must not hold the batch open.
    settled:
      (npxPhase !== 'idle' || offlinePhase !== 'idle') &&
      npxPhase !== 'working' &&
      offlinePhase !== 'working',
    attemptedNames: [
      ...(npxSettled ? npxRun.names : []),
      ...(offlineSettled ? offlineRun.names : [])
    ],
    failedNpxNames: npxRun.state === 'error' ? [...npxRun.failedNames] : [],
    failedOfflineNames,
    failed: npxRun.state === 'error' || failedOfflineNames.length > 0
  }
}

/** Post-run headline. Counts both rails, so half a batch failing can't read as success. */
export function SkillUpdateOutcomeHeadline({
  outcome
}: {
  outcome: SkillUpdateCombinedOutcome
}): React.JSX.Element {
  const attempted = outcome.attemptedNames.length
  const failed = outcome.failedNpxNames.length + outcome.failedOfflineNames.length
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
      {outcome.failed ? (
        <AlertTriangle className="size-4 text-destructive" />
      ) : (
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
      )}
      {outcome.failed
        ? translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.updatedPartial',
            'Updated {{value0}} of {{value1}} skills',
            { value0: attempted - failed, value1: attempted }
          )
        : attempted === 1
          ? translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updatedOne',
              'Updated 1 skill'
            )
          : translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updatedMany',
              'Updated {{value0}} skills',
              { value0: attempted }
            )}
    </div>
  )
}

/** One panel for both rails: a failure on either is the same interruption. */
export function SkillUpdateFailurePanel({
  outcome,
  message,
  copied,
  onRetry,
  onCopyCommand
}: {
  outcome: SkillUpdateCombinedOutcome
  message: string | null
  copied: boolean
  onRetry: () => void
  onCopyCommand: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-2.5 rounded-md border border-destructive/35 bg-destructive/10 p-3">
      <p className="text-[13px] font-medium text-foreground">
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.errorTitle',
          "The update didn't finish"
        )}
      </p>
      {/* Mono because it is the runner's own output, quoted verbatim. */}
      {message ? (
        <p className="break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
          {message}
        </p>
      ) : null}
      {outcome.failedOfflineNames.length > 0 ? (
        <p className="break-words text-[11px] leading-relaxed text-muted-foreground">
          {translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.offlineFailed',
            'Orca could not update {{value0}} from this app build.',
            { value0: outcome.failedOfflineNames.join(', ') }
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {/* Retry what actually failed, not the live eligibility list — the settling
            re-scan empties that for the whole window this button is on screen. */}
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          {translate('auto.components.skills.SkillFreshnessUpdateDialog.retry', 'Retry')}
        </Button>
        {/* Only for npx failures: the copied command is `skills update`, which changes
            nothing for a name that rail's lock has never heard of. */}
        {outcome.failedNpxNames.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5"
            onClick={onCopyCommand}
          >
            <Copy className="size-3.5" />
            {copied
              ? translate('auto.components.skills.SkillFreshnessUpdateDialog.copied', 'Copied')
              : translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.copyCommand',
                  'Copy command'
                )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
