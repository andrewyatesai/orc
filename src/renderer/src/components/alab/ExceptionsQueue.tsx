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
import {
  collapseExceptionsByTask,
  unwiredExceptionSources,
  type FleetException
} from './fleet-exceptions'
import { useFleetSnapshot } from './use-fleet-orchestration-poll'

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
  const { exceptions: raw, loadedAt, error } = useFleetSnapshot()

  // Already classified and task-keyed by the runtime; the renderer only applies
  // §8.3's collapse rule, which is where a retry storm becomes one readable row.
  const exceptions = useMemo(
    () =>
      collapseExceptionsByTask(
        raw.map((entry) => ({
          taskId: entry.taskId,
          kind: entry.kind as FleetException['kind'],
          summary: entry.summary,
          workerHandle: entry.workerHandle,
          attempts: entry.attempts,
          at: entry.at
        }))
      ),
    [raw]
  )

  const unwired = unwiredExceptionSources()

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
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto scrollbar-sleek"
      >
        {exceptions.map((exception) => (
          <ExceptionRow key={exception.taskId} exception={exception} />
        ))}
      </ul>

      {error ? (
        <p className="shrink-0 text-[11px] text-destructive" role="status">
          {/* NEVER the reassuring empty state on a failed poll: "nothing is
              waiting on you" while the request is failing is the single most
              dangerous sentence this console can print. */}
          {translate(
            'alab.exceptions.unknown',
            'Cannot reach the runtime, so this may be out of date.'
          )}
        </p>
      ) : loadedAt !== null && exceptions.length === 0 ? (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          {/* Truthful only because `ask --task` opens real gates now — and only
              about GATES, which is why the caveat below is not optional. */}
          {translate('alab.exceptions.empty', 'Nothing is waiting on you.')}
        </p>
      ) : null}

      {unwired.length > 0 ? (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          {/* Says what it cannot see. A supervisor who believes this queue covers
              all six sources reads an empty queue as "all clear". */}
          {translate(
            'alab.exceptions.partial',
            'Rejected handoffs and unanswered questions are not shown here yet.'
          )}
        </p>
      ) : null}
    </div>
  )
}
