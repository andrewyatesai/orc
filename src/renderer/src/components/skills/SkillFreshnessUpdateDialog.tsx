import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  buildTargetedSkillUpdateCommand,
  isSkillScanIssueNeedingAttention,
  isSkillScanIssueTruncatingScan,
  type SkillFreshnessInventory
} from '../../../../shared/skill-freshness'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { groupSkillFreshness } from './skill-freshness-grouping'
import { SkillFreshnessScanIssues } from './skill-freshness-scan-issues'
import { SkillUpdateRow } from './SkillUpdateRow'
import { skillUpdateRowStates } from './skill-update-row-states'
import { SkillUpdateRunLog } from './SkillUpdateRunLog'
import { SummaryHeadline, summarizeInventory } from './skill-freshness-summary-headline'
import {
  acknowledgeSkillUpdateRun,
  cancelSkillUpdateRun,
  startSkillUpdateRun,
  useSkillUpdateRun
} from './skill-update-run-store'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  getSkillFreshnessUpdateDialogRequest,
  subscribeSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'
import {
  acknowledgeOfflineSkillUpdateRun,
  startOfflineSkillUpdate,
  useOfflineSkillUpdateRun
} from './skill-offline-update-run'
import {
  combineSkillUpdateOutcome,
  SkillUpdateFailurePanel,
  SkillUpdateOutcomeHeadline,
  type SkillUpdateRailsDispatched
} from './skill-update-combined-outcome'

export function SkillFreshnessUpdateDialog(): React.JSX.Element {
  const state = useSkillFreshness()
  const run = useSkillUpdateRun()
  const offlineRun = useOfflineSkillUpdateRun()
  const open = useSyncExternalStore(
    subscribeSkillFreshnessUpdateDialog,
    getSkillFreshnessUpdateDialogRequest,
    getSkillFreshnessUpdateDialogRequest
  )
  const [copied, setCopied] = useState(false)
  // Which rails this press asked for; see the note in handleUpdate.
  const [dispatched, setDispatched] = useState<SkillUpdateRailsDispatched>({})

  // Why: settling a run notifies every skills surface, and that refresh nulls the
  // inventory *synchronously* while it re-hashes each package on disk. Rendering
  // rows off the last good scan keeps them on screen through that window instead
  // of blanking the dialog at the exact moment the result appears. Eligibility
  // below still reads the live snapshot, so nothing is authorized off stale bytes.
  const lastInventoryRef = useRef<SkillFreshnessInventory | null>(null)
  if (state.inventory) {
    lastInventoryRef.current = state.inventory
  }
  const inventory = state.inventory ?? (state.loading ? lastInventoryRef.current : null)
  const eligibleNames = useMemo(() => state.inventory?.eligibleUpdateNames ?? [], [state.inventory])
  // Why: names this build ships bytes for have no npx lock entry, so `skills update`
  // could only report success and change nothing. They go to the bundled installer.
  const offlineEligibleNames = useMemo(
    () => new Set(state.inventory?.offlineUpdateNames ?? []),
    [state.inventory]
  )
  // Display only. The action still fires `eligibleNames`, so a re-scan in flight
  // can never authorize work — but the button keeps its place and its label
  // instead of vanishing and reflowing the footer every time one runs.
  const displayEligibleCount = inventory?.eligibleUpdateNames.length ?? 0
  const isRunning = run.state === 'running'
  // Why: an offline write owns the dialog the same way an npx run does, but there is
  // nothing to stop and no log to show — it is one atomic swap per package.
  const isInstallingOffline = offlineRun.running
  // The kill sweep can take seconds; without this the Stop button sits enabled
  // and inert, which reads as broken.
  const isStopping = run.state === 'running' && run.stopping === true
  // Why: an npx success settles first while a bundled write is still refusing, so
  // every result surface below reads BOTH rails or it announces half the truth.
  const outcome = combineSkillUpdateOutcome(run, offlineRun, dispatched)
  const hasNpxResult = run.state === 'success' || run.state === 'error'
  const showResult = outcome.settled
  // Keyed on the names themselves: every captured output chunk republishes the
  // run, and regrouping the whole inventory per chunk would re-render each row.
  const runNamesKey = run.state === 'idle' ? '' : run.names.join('\n')
  const runNames = useMemo(() => (runNamesKey ? runNamesKey.split('\n') : []), [runNamesKey])
  const offlineRunNames = offlineRun.names
  const pinnedNames = useMemo(() => [...runNames, ...offlineRunNames], [offlineRunNames, runNames])
  const groups = useMemo(
    () =>
      inventory
        ? groupSkillFreshness(inventory.installations, inventory.eligibleUpdateNames, pinnedNames)
        : [],
    [inventory, pinnedNames]
  )
  const hasBlockedGroup = groups.some((group) => group.status === 'cannot-update')
  const blockedCount = groups.filter((group) => group.status === 'cannot-update').length
  // Retained: the list keeps the last known folders on screen through a re-scan, the
  // same way the rows above stay put rather than blanking.
  const scanIssues = inventory?.scanIssues ?? []
  // Why: the headline reads the LIVE snapshot, not the retained one — the two
  // disagree for the whole loading window, and pairing a retained "eligible" with
  // a live count of 0 renders "0 updates available" over rows badged "Update
  // available". Live means it says "Checking…" over the rows it kept on screen.
  const summaryKind = summarizeInventory(
    state.inventory,
    hasBlockedGroup,
    (state.inventory?.scanIssues ?? []).some(
      (issue) => isSkillScanIssueNeedingAttention(issue) || isSkillScanIssueTruncatingScan(issue)
    )
  )

  const failedNamesKey = run.state === 'error' ? run.failedNames.join('\n') : ''
  const rows = useMemo(
    () =>
      skillUpdateRowStates({
        groups,
        runNames,
        isRunning,
        failedNames: failedNamesKey ? failedNamesKey.split('\n') : [],
        offlineNames: offlineRunNames,
        isInstallingOffline,
        offlineFailedNames: offlineRun.failedNames
      }),
    [
      groups,
      isRunning,
      failedNamesKey,
      isInstallingOffline,
      offlineRun.failedNames,
      offlineRunNames,
      runNames
    ]
  )

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      return
    }
    // Why: closing never cancels. The run is owned by main and keeps going; the
    // status-bar segment carries it from here.
    consumeSkillFreshnessUpdateDialogRequest()
    setCopied(false)
    // Don't carry a finished session's rows into the next open — but a live run
    // keeps its own, or reopening from the status segment mid-run would land on
    // an empty list while the close's own re-scan is still reading disk.
    if (run.state === 'idle') {
      lastInventoryRef.current = null
    }
    acknowledgeOfflineSkillUpdateRun()
    if (hasNpxResult) {
      void acknowledgeSkillUpdateRun()
    }
    notifyInstalledAgentSkillsChanged()
  }

  // Why: the two rails are not interchangeable. `skills update` only knows names its
  // lock records, and the bundled installer refuses names that lock owns — so each
  // name goes to the one updater that can actually move it.
  const handleUpdate = (names: readonly string[]): void => {
    const offlineTargets = names.filter((name) => offlineEligibleNames.has(name))
    const npxTargets = names.filter((name) => !offlineEligibleNames.has(name))
    // Why: a rail that was dispatched but has not reported yet is indistinguishable
    // from one never asked — both read 'idle'. Without this the faster rail settles
    // the dialog and announces half the batch.
    setDispatched({ npx: npxTargets.length > 0, offline: offlineTargets.length > 0 })
    if (offlineTargets.length > 0) {
      void startOfflineSkillUpdate(offlineTargets)
    }
    if (npxTargets.length > 0) {
      void startSkillUpdateRun(npxTargets)
    }
  }

  // Why: routed by the rail each name failed on, not by live eligibility — the
  // settling re-scan empties that, and the two updaters cannot cover for each other.
  const handleRetry = (): void => {
    setDispatched({
      npx: outcome.failedNpxNames.length > 0,
      offline: outcome.failedOfflineNames.length > 0
    })
    if (outcome.failedOfflineNames.length > 0) {
      void startOfflineSkillUpdate(outcome.failedOfflineNames)
    }
    if (outcome.failedNpxNames.length > 0) {
      void startSkillUpdateRun(outcome.failedNpxNames)
    }
  }

  const handleCopyCommand = (): void => {
    const command = buildTargetedSkillUpdateCommand(
      outcome.failedNpxNames.length > 0 ? outcome.failedNpxNames : eligibleNames
    )
    if (!command) {
      return
    }
    // Clipboard writes reject on a denied permission or an unfocused document;
    // without this the button just never flips to "Copied".
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch((error: unknown) => {
        console.error('Failed to copy skill update command', error)
      })
  }

  const headline = ((): React.JSX.Element => {
    if (isStopping) {
      // Why: no "keeps running in the background" line here — after Stop that is
      // the opposite of what is happening.
      return (
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          {translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.stoppingHeadline',
            'Stopping the update…'
          )}
        </div>
      )
    }
    if (isRunning || isInstallingOffline) {
      // A mixed update runs both rails at once, so the count is the whole batch.
      const updatingCount =
        (isRunning ? run.names.length : 0) + (isInstallingOffline ? offlineRunNames.length : 0)
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            {updatingCount === 1
              ? translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.runningOne',
                  'Updating 1 skill…'
                )
              : translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.runningMany',
                  'Updating {{value0}} skills…',
                  { value0: updatingCount }
                )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.runningDescription',
              'You can close this window — it keeps running in the background.'
            )}
          </p>
        </div>
      )
    }
    if (outcome.settled) {
      return <SkillUpdateOutcomeHeadline outcome={outcome} />
    }
    return (
      <SummaryHeadline
        kind={summaryKind}
        eligibleCount={eligibleNames.length}
        blockedCount={blockedCount}
      />
    )
  })()

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="scrollbar-sleek max-h-[85vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.skills.SkillFreshnessUpdateDialog.title', 'Update skills')}
          </DialogTitle>
        </DialogHeader>

        {state.error && !isRunning && !showResult ? (
          <p className="min-w-0 [overflow-wrap:anywhere] text-xs text-destructive">{state.error}</p>
        ) : (
          headline
        )}

        {isRunning || isInstallingOffline ? (
          // Indeterminate on purpose: the CLI reports no parseable progress.
          <div
            role="progressbar"
            aria-label={
              isStopping
                ? translate(
                    'auto.components.skills.SkillFreshnessUpdateDialog.stoppingHeadline',
                    'Stopping the update…'
                  )
                : translate(
                    'auto.components.skills.SkillFreshnessUpdateDialog.progressAria',
                    'Updating skills'
                  )
            }
            className="h-1 overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div
            className={`min-w-0 ${isRunning || isInstallingOffline ? '' : 'border-t border-border/60'}`}
          >
            <TooltipProvider>
              {rows.map((row) => (
                <SkillUpdateRow key={row.group.name} group={row.group} state={row.state} />
              ))}
            </TooltipProvider>
          </div>
        ) : null}

        {/* Why: folders, not skills — a plugin path Orca could not read says nothing
            about which skill lives there, so it cannot be a row above. */}
        {scanIssues.length > 0 ? (
          <div className="min-w-0 border-t border-border/60 pt-3">
            <SkillFreshnessScanIssues issues={scanIssues} />
          </div>
        ) : null}

        {outcome.settled && outcome.failed ? (
          <SkillUpdateFailurePanel
            outcome={outcome}
            message={run.state === 'error' ? run.message : null}
            copied={copied}
            onRetry={handleRetry}
            onCopyCommand={handleCopyCommand}
          />
        ) : null}

        {/* The log is the npx rail's own stdout; the offline rail has none. */}
        {isRunning || hasNpxResult ? <SkillUpdateRunLog output={run.output} /> : null}

        <DialogFooter className="sm:justify-between">
          {isRunning ? (
            // The terminal used to be the escape hatch for a stalled update;
            // without it a wedged npx would leave restarting Orca as the only way out.
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isStopping}
              onClick={() => void cancelSkillUpdateRun()}
            >
              {isStopping
                ? translate(
                    'auto.components.skills.SkillFreshnessUpdateDialog.stopping',
                    'Stopping…'
                  )
                : translate('auto.components.skills.SkillFreshnessUpdateDialog.stop', 'Stop')}
            </Button>
          ) : showResult ? (
            <span />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={state.loading}
              onClick={() => void state.refresh()}
            >
              <RefreshCw className={state.loading ? 'animate-spin' : undefined} />
              {translate('auto.components.skills.SkillFreshnessUpdateDialog.checkNow', 'Re-check')}
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
              {/* "Done" only when nothing on either rail is still waiting on the user. */}
              {outcome.settled && !outcome.failed
                ? translate('auto.components.skills.SkillFreshnessUpdateDialog.done', 'Done')
                : translate('auto.components.skills.SkillFreshnessUpdateDialog.close', 'Close')}
            </Button>
            {!showResult && displayEligibleCount > 0 ? (
              <Button
                type="button"
                size="sm"
                disabled={isRunning || isInstallingOffline || eligibleNames.length === 0}
                onClick={() => handleUpdate(eligibleNames)}
              >
                {/* Not during a stop: the Stop button already carries the status,
                    and "Updating…" beside "Stopping…" says both at once. */}
                {(isRunning && !isStopping) || isInstallingOffline
                  ? translate(
                      'auto.components.skills.SkillFreshnessUpdateDialog.updating',
                      'Updating…'
                    )
                  : displayEligibleCount === 1
                    ? translate(
                        'auto.components.skills.SkillFreshnessUpdateDialog.updateActionOne',
                        'Update 1 skill'
                      )
                    : translate(
                        'auto.components.skills.SkillFreshnessUpdateDialog.updateActionMany',
                        'Update {{value0}} skills',
                        { value0: displayEligibleCount }
                      )}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
