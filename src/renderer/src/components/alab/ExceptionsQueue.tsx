/**
 * Everything that stopped and needs a human — `docs/reference/app-modes.md` §8.3.
 *
 * **One row per task, collapsed on task id BEFORE ordering.** This is the whole
 * design of the component. A deterministic failure produces
 * escalation → retry → escalation → retry → escalation → circuit_broken within
 * about ten seconds; rendered raw that is six rows for one problem, and the
 * queue becomes unreadable exactly when it matters most. The supervisor needs
 * "task X is stuck, 3 attempts" — one line, with the count.
 *
 * **`aria-live="polite"`, and always mounted.** This queue mutates unattended at
 * 2am. A supervisor using a screen reader must hear a gate open, and a region
 * that only exists once something is wrong cannot announce the thing going
 * wrong.
 *
 * Sources, per §8.3: pending gates; `escalation` messages; `circuit_broken`
 * dispatches; lifecycle rejections; attention-bucket agent rows with no gate;
 * unanswered asks. This component consumes whatever the collapse function is
 * given — it does not decide which sources exist, so adding one later is a
 * change to the reducer and not to the UI.
 */

import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { collapseExceptionsByTask, type FleetException } from './fleet-exceptions'
import { useFleetOrchestrationPoll } from './use-fleet-orchestration-poll'

function ExceptionRow({ exception }: { exception: FleetException }): React.JSX.Element {
  return (
    <li className="flex items-start gap-2 rounded-md border p-2" data-testid="alab-exception-row">
      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase text-muted-foreground">
        {exception.kind}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-xs">{exception.summary}</span>
        <span className="text-[11px] text-muted-foreground">
          {exception.workerHandle ?? translate('alab.exceptions.noWorker', 'no worker')}
          {exception.attempts > 1
            ? ` · ${exception.attempts} ${translate('alab.exceptions.attempts', 'attempts')}`
            : ''}
        </span>
      </span>
    </li>
  )
}

export function ExceptionsQueue(): React.JSX.Element {
  const { runs, loadedAt } = useFleetOrchestrationPoll()

  // Today's only wired source is the per-run pending-gate count. The remaining
  // five sources land in the reducer, not here — see fleet-exceptions.ts, which
  // states honestly which are connected.
  const exceptions = useMemo(
    () =>
      collapseExceptionsByTask(
        runs.flatMap((run) =>
          run.pendingGates > 0
            ? [
                {
                  taskId: `run:${run.id}`,
                  kind: 'gate' as const,
                  summary: translate('alab.exceptions.gateWaiting', 'A worker is waiting on you.'),
                  workerHandle: run.coordinator_handle,
                  attempts: 1,
                  at: run.created_at ?? ''
                }
              ]
            : []
        )
      ),
    [runs]
  )

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden" data-testid="alab-exceptions">
      <h2 className="shrink-0 text-xs font-semibold text-muted-foreground">
        {translate('alab.exceptions.heading', 'Needs you')}
      </h2>
      {/* Always rendered, never conditional: an aria-live region that appears
          only when non-empty announces nothing when it fills. */}
      <ul
        aria-live="polite"
        aria-label={translate('alab.exceptions.heading', 'Needs you')}
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
      >
        {exceptions.map((exception) => (
          <ExceptionRow key={exception.taskId} exception={exception} />
        ))}
      </ul>
      {loadedAt !== null && exceptions.length === 0 ? (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          {/* Only truthful because `ask --task` opens real gates now; before
              that this line was a lie whenever a worker was blocked. */}
          {translate('alab.exceptions.empty', 'Nothing is waiting on you.')}
        </p>
      ) : null}
    </div>
  )
}
