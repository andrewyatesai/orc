/**
 * Who is doing what — `docs/reference/app-modes.md` §8.3.
 *
 * Grouped by MISSION (`coordinatorHandle ?? orchestrationRunId ?? 'unassigned'`),
 * not by worktree. A handle can host sequential runs, so grouping by handle keeps
 * a mission's history together across restarts; grouping by run id fragments the
 * board after every restart. The final `unassigned` group exists so a human's
 * hand-started agent is never silently hidden.
 *
 * **What this build cannot yet show, and says so.** §8.3 requires every worker
 * row to render `last_heartbeat_at` directly, because agent-hook status alone
 * cannot distinguish wedged from finished: `AGENT_STATUS_STALE_AFTER_MS` decays
 * a non-`done` entry to `idle` at thirty minutes, so a wedged worker and a
 * cleanly-finished one look identical. There is no per-worker heartbeat feed
 * wired yet, so this board shows mission-level state and names the gap rather
 * than rendering an agent list that would imply liveness it cannot prove.
 */

import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useFleetSnapshot, type FleetRun } from './use-fleet-orchestration-poll'

const UNASSIGNED = '__unassigned__'

/** A run with no coordinator handle is not part of a named mission. Falling back
 *  to `run.id` (which is always present) made UNASSIGNED unreachable and gave
 *  every such run its own single-row group. */
function missionKey(run: FleetRun): string {
  return run.coordinator_handle ?? UNASSIGNED
}

function MissionGroup({ mission, runs }: { mission: string; runs: FleetRun[] }): React.JSX.Element {
  const active = runs.filter((run) => run.live).length
  return (
    <section className="flex flex-col gap-1" data-testid="alab-fleet-group">
      <h3 className="sticky top-0 z-10 flex items-center gap-2 bg-background/95 py-1 text-[11px] font-medium">
        <span className="truncate">
          {mission === UNASSIGNED
            ? translate('alab.fleet.unassigned', 'Not part of a mission')
            : mission}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {active}/{runs.length} {translate('alab.fleet.live', 'live')}
        </span>
      </h3>
      <ul className="flex flex-col gap-1">
        {runs.map((run) => (
          <li
            key={run.id}
            className="flex items-center gap-2 rounded border px-2 py-1 text-[11px]"
            data-testid="alab-fleet-row"
          >
            <span className="truncate">{run.spec || run.id}</span>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
              {/* "dispatched" is not "working" when nothing is driving the run:
                  a stranded row's tasks were handed out and then abandoned. */}
              {run.tasks.dispatched}{' '}
              {run.live
                ? translate('alab.fleet.working', 'working')
                : translate('alab.fleet.stranded', 'stranded')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Per-worker liveness, from `last_heartbeat_at` directly.
 *
 * This is the §8.3 requirement the first version could not meet: agent-hook
 * status alone cannot distinguish wedged from finished, because
 * `AGENT_STATUS_STALE_AFTER_MS` decays a non-`done` entry to `idle` at thirty
 * minutes — so a hung worker and a cleanly-finished one look identical. The
 * heartbeat is the only signal that separates them, so it is rendered as an age,
 * not as a status word.
 */
function WorkerHeartbeats(): React.JSX.Element | null {
  const { dispatches, loadedAt } = useFleetSnapshot()
  const active = dispatches.filter((dispatch) => dispatch.status === 'dispatched')
  if (loadedAt === null || active.length === 0) {
    return null
  }
  const now = Date.now()
  return (
    <section className="mt-2 flex flex-col gap-1" data-testid="alab-heartbeats">
      <h3 className="text-[11px] font-medium text-muted-foreground">
        {translate('alab.fleet.workers', 'Workers')}
      </h3>
      <ul className="flex flex-col gap-1">
        {active.map((dispatch) => {
          const beat = dispatch.last_heartbeat_at ?? dispatch.dispatched_at
          const ageMs = beat ? now - Date.parse(beat) : null
          const silentMinutes = ageMs === null ? null : Math.floor(ageMs / 60_000)
          return (
            <li
              key={dispatch.id}
              className="flex items-center gap-2 rounded border px-2 py-1 text-[11px]"
              data-testid="alab-worker-row"
            >
              <span className="truncate">{dispatch.assignee_handle ?? '—'}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                {silentMinutes === null
                  ? translate('alab.fleet.neverHeard', 'never heard from')
                  : `${silentMinutes}m ${translate('alab.fleet.silent', 'silent')}`}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function FleetBoard(): React.JSX.Element {
  const { runs, loadedAt, error } = useFleetSnapshot()

  const groups = useMemo(() => {
    const byMission = new Map<string, FleetRun[]>()
    for (const run of runs) {
      const key = missionKey(run)
      byMission.set(key, [...(byMission.get(key) ?? []), run])
    }
    // `unassigned` sorts last so a human's own pane never displaces fleet work.
    return [...byMission.entries()].sort(([left], [right]) => {
      if (left === UNASSIGNED) {
        return 1
      }
      if (right === UNASSIGNED) {
        return -1
      }
      return left.localeCompare(right)
    })
  }, [runs])

  return (
    <div
      className="flex h-full flex-col gap-2 overflow-y-auto scrollbar-sleek"
      data-testid="alab-fleet-board"
    >
      <h2 className="text-xs font-semibold text-muted-foreground">
        {translate('alab.fleet.heading', 'Fleet')}
      </h2>
      {groups.map(([mission, missionRuns]) => (
        <MissionGroup key={mission} mission={mission} runs={missionRuns} />
      ))}
      {error ? (
        <p className="text-[11px] text-destructive" role="status">
          {/* Never "no agents are running" on a failed poll — that is a claim
              about the fleet made from a request that never arrived. */}
          {translate('alab.fleet.unknown', 'Cannot reach the runtime, so this may be out of date.')}
        </p>
      ) : loadedAt !== null && groups.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('alab.fleet.none', 'No coordinator runs.')}
        </p>
      ) : null}
      <WorkerHeartbeats />
    </div>
  )
}
