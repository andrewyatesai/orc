/**
 * Work that is ready to look at — `docs/reference/app-modes.md` §8.3/§8.4.
 *
 * Review is the supervisor's dominant morning activity, so treating it as
 * "switch to Classic" would make it an exit FROM the mode rather than a function
 * of it. This band is where a completed task and its evidence meet.
 *
 * Collapsed when empty (§8.3): a permanent "nothing to review" header is noise
 * on a console whose whole job is to surface the few things that need a person.
 */

import { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { MissionLog } from './MissionLog'
import { TaskDetail } from './TaskDetail'
import { useFleetSnapshot } from './use-fleet-orchestration-poll'

export function LandingBand(): React.JSX.Element | null {
  const { tasks, dispatches, reconciliations, runs } = useFleetSnapshot()
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  const landed = useMemo(
    () => tasks.filter((task) => task.status === 'completed' || task.status === 'failed'),
    [tasks]
  )
  const dispatchByTask = useMemo(
    () => new Map(dispatches.map((dispatch) => [dispatch.task_id, dispatch])),
    [dispatches]
  )
  const reconciliationByTask = useMemo(
    () => new Map(reconciliations.map((entry) => [entry.taskId, entry])),
    [reconciliations]
  )

  if (landed.length === 0) {
    return null
  }

  const openTask = landed.find((task) => task.id === openTaskId) ?? null
  const openRunId = openTask?.run_id ?? runs[0]?.id ?? null

  return (
    <section className="flex flex-col gap-1.5 overflow-hidden" data-testid="alab-landing">
      <h2 className="shrink-0 text-xs font-semibold text-muted-foreground">
        {translate('alab.landing.heading', 'Ready to look at')}
      </h2>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {landed.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-[11px]"
              onClick={() => setOpenTaskId((current) => (current === task.id ? null : task.id))}
            >
              <span className="truncate">{task.task_title || task.display_name || task.spec}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">{task.status}</span>
            </button>
          </li>
        ))}
      </ul>

      {openTask ? (
        <div className="flex flex-col gap-2 overflow-y-auto">
          <TaskDetail
            task={openTask}
            dispatch={dispatchByTask.get(openTask.id)}
            reconciliation={reconciliationByTask.get(openTask.id) ?? null}
          />
          {openRunId ? <MissionLog runId={openRunId} /> : null}
        </div>
      ) : null}
    </section>
  )
}
