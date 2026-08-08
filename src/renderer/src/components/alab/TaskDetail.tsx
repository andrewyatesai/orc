/**
 * The evidence for one task — `docs/reference/app-modes.md` §8.4.
 *
 * De-emphasising workflow mechanics does NOT mean removing the signals capable
 * of contradicting an agent. Without these, "completed" is entirely
 * self-attestation: the worker says it finished, and nothing else is consulted.
 *
 * The claim/actual comparison is the highest-signal row here. It degrades to
 * "cannot check" on a folder workspace rather than to "mismatch" — an absent
 * answer is not a discrepancy, and crying mismatch would train a supervisor to
 * ignore the one alert that matters.
 */

import { translate } from '@/i18n/i18n'
import type { FleetDispatch, FleetTask } from './use-fleet-orchestration-poll'

export type TaskDetailProps = {
  task: FleetTask
  dispatch?: FleetDispatch
  /** Server-computed; null when this build could not check (see §8.4). */
  reconciliation?: { verdict: string; summary: string } | null
}

function claimedFiles(result: string | null): string[] {
  if (!result) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(result)
    const files = (parsed as { filesModified?: unknown })?.filesModified
    return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : []
  } catch {
    return []
  }
}

export function TaskDetail({ task, dispatch, reconciliation }: TaskDetailProps): React.JSX.Element {
  const files = claimedFiles(task.result)
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="alab-task-detail">
      <h3 className="text-xs font-medium">{task.task_title || task.display_name || task.spec}</h3>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">{translate('alab.task.status', 'Status')}</dt>
        <dd>{task.status}</dd>

        {dispatch ? (
          <>
            <dt className="text-muted-foreground">{translate('alab.task.worker', 'Worker')}</dt>
            <dd>{dispatch.assignee_handle ?? '—'}</dd>

            {/* The retry counter. A supervisor reads this as "this keeps failing",
                which a single status word cannot express. */}
            <dt className="text-muted-foreground">{translate('alab.task.attempts', 'Attempts')}</dt>
            <dd className="tabular-nums">{dispatch.failure_count + 1}</dd>

            {dispatch.last_failure ? (
              <>
                <dt className="text-muted-foreground">
                  {translate('alab.task.lastFailure', 'Last failure')}
                </dt>
                <dd className="truncate">{dispatch.last_failure}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>

      {files.length > 0 ? (
        <div className="text-[11px]">
          <span className="text-muted-foreground">
            {translate('alab.task.claimedFiles', 'Files it says it changed')}
          </span>
          <ul className="mt-1 list-disc pl-5">
            {files.map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {reconciliation ? (
        <p
          className={
            reconciliation.verdict === 'mismatch'
              ? 'text-[11px] text-destructive'
              : 'text-[11px] text-muted-foreground'
          }
          data-testid="alab-task-reconciliation"
        >
          {/* The only line on this console that can disagree with the agent. */}
          {reconciliation.summary}
        </p>
      ) : null}
    </div>
  )
}
