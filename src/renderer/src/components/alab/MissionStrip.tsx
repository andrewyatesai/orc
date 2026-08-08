/**
 * ALab's `left-sidebar-body` capsule — `docs/reference/app-modes.md` §8.3.
 *
 * One row per coordinator run, and the counters are **split, never a fraction**.
 * That is the load-bearing decision in this file: `checkConvergence` counts
 * `failed` toward "all done", so `8/8` would launder two failures into a
 * success. A supervisor reading `6 done · 2 failed` sees the thing she has to
 * act on; a supervisor reading `8/8` goes to bed.
 *
 * Every row also shows whether the run is LIVE. A durable row still reads
 * `running` after a restart killed its loop, so status alone cannot separate a
 * live coordinator from a stranded one — the in-memory registry is the only
 * witness, and `runList` surfaces it.
 */

import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useFleetSnapshot, type FleetRun } from './use-fleet-orchestration-poll'

/**
 * Amber on anything that means the run will not finish on its own.
 *
 * `stranded` is the one that is easy to miss and the most important: a row whose
 * status still says `running` with no loop behind it cannot progress at all, yet
 * it shows no failures and no gates. Without it here, a restart-stranded run
 * sorts BELOW newer healthy runs — the one run that needs a human, ranked last.
 */
function runNeedsAttention(run: FleetRun): boolean {
  const stranded = !run.live && run.status === 'running'
  return stranded || run.tasks.failed > 0 || run.tasks.blocked > 0 || run.pendingGates > 0
}

function CounterPill({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'neutral' | 'good' | 'bad'
}): React.JSX.Element | null {
  // A zero counter is noise; the supervisor is scanning for non-zero.
  if (value === 0) {
    return null
  }
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] tabular-nums',
        tone === 'good' && 'bg-[var(--status-success-background)] text-[var(--status-success)]',
        tone === 'bad' && 'bg-destructive/15 text-destructive',
        tone === 'neutral' && 'bg-muted text-muted-foreground'
      )}
    >
      {value} {label}
    </span>
  )
}

function MissionRow({ run }: { run: FleetRun }): React.JSX.Element {
  const attention = runNeedsAttention(run)
  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-md border p-2',
        attention && 'border-[var(--status-warning-border,theme(colors.amber.500))]'
      )}
      data-testid="alab-mission-row"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium" title={run.spec ?? undefined}>
          {run.spec || run.coordinator_handle || run.id}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {run.live
            ? translate('alab.mission.live', 'live')
            : /* Named, not hidden: a durable row can claim `running` with no loop
                 behind it, and that is exactly the state a supervisor must see. */
              translate('alab.mission.notLive', 'no loop')}
        </span>
      </div>

      {/* Split counters — never a fraction. See the file header. */}
      <div className="flex flex-wrap items-center gap-1">
        <CounterPill
          label={translate('alab.mission.done', 'done')}
          value={run.tasks.completed}
          tone="good"
        />
        <CounterPill
          label={translate('alab.mission.failed', 'failed')}
          value={run.tasks.failed}
          tone="bad"
        />
        <CounterPill
          label={translate('alab.mission.blocked', 'blocked')}
          value={run.tasks.blocked}
          tone="bad"
        />
        <CounterPill
          label={translate('alab.mission.dispatched', 'dispatched')}
          value={run.tasks.dispatched}
          tone="neutral"
        />
        <CounterPill
          label={translate('alab.mission.waiting', 'waiting')}
          value={run.tasks.readyOrPending}
          tone="neutral"
        />
        {run.pendingGates > 0 ? (
          <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive">
            {/* The only counter naming a HUMAN as the blocker. */}
            {run.pendingGates} {translate('alab.mission.waitingOnYou', 'waiting on you')}
          </span>
        ) : null}
      </div>
    </li>
  )
}

export default function MissionStrip(): React.JSX.Element {
  const { runs, loadedAt, error } = useFleetSnapshot()
  // Attention first, then newest. A supervisor scans top-down.
  const ordered = useMemo(
    () =>
      [...runs].sort((left, right) => {
        const byAttention = Number(runNeedsAttention(right)) - Number(runNeedsAttention(left))
        return byAttention !== 0
          ? byAttention
          : (right.created_at ?? '').localeCompare(left.created_at ?? '')
      }),
    [runs]
  )

  return (
    <div
      className="flex h-full flex-col gap-2 overflow-y-auto p-2"
      data-testid="alab-mission-strip"
    >
      <h2 className="text-xs font-semibold text-muted-foreground">
        {translate('alab.mission.heading', 'Missions')}
      </h2>

      {error ? (
        <p className="text-[11px] text-destructive" role="status">
          {/* Never silently stale: a console showing old rows as if current is
              worse than one admitting it lost contact. */}
          {translate('alab.mission.disconnected', 'Lost contact with the runtime.')}
        </p>
      ) : null}

      {loadedAt === null ? null : ordered.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('alab.mission.none', 'No missions yet.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {ordered.map((run) => (
            <MissionRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </div>
  )
}
