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
import { useFleetOrchestrationPoll, type FleetRun } from './use-fleet-orchestration-poll'

const UNASSIGNED = '__unassigned__'

function missionKey(run: FleetRun): string {
  return run.coordinator_handle ?? run.id ?? UNASSIGNED
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
              {run.tasks.dispatched} {translate('alab.fleet.working', 'working')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function FleetBoard(): React.JSX.Element {
  const { runs, loadedAt } = useFleetOrchestrationPoll()

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
    <div className="flex h-full flex-col gap-2 overflow-y-auto" data-testid="alab-fleet-board">
      <h2 className="text-xs font-semibold text-muted-foreground">
        {translate('alab.fleet.heading', 'Fleet')}
      </h2>
      {groups.map(([mission, missionRuns]) => (
        <MissionGroup key={mission} mission={mission} runs={missionRuns} />
      ))}
      {loadedAt !== null && groups.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('alab.fleet.none', 'No agents are running.')}
        </p>
      ) : null}
      <p className="mt-auto pt-2 text-[11px] text-muted-foreground">
        {/* Named rather than implied. A board that silently omits per-worker
            liveness would let a supervisor read "no news" as "healthy". */}
        {translate(
          'alab.fleet.noHeartbeats',
          'Per-agent heartbeats are not shown yet, so this cannot tell a stuck worker from a finished one.'
        )}
      </p>
    </div>
  )
}
