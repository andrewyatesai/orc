import type { RustOrchestrationStoreHandle } from '../../daemon/rust-git-addon'
import { listFromJson } from './db-row-json'
import type { CoordinatorRun } from './types'

/**
 * Run ownership (design §4). The column is only half of it — the other half is
 * deciding WHICH run owns a task that existed before any run did.
 *
 * The design offered two: `runCreate` + a required `runId` on task creation, or
 * one atomic collision-detecting adoption at run start. **This ships adoption.**
 * The required-runId option cannot be reconciled with the workflow that exists:
 * `taskCreate` (CLI and RPC alike) runs before `orchestration.run` mints a run,
 * so requiring the id would break every current caller and strand every task an
 * installed build already wrote.
 *
 * How it works: `createCoordinatorRun` inserts the run and stamps its id onto
 * every un-owned LIVE task — plus those tasks' gates and dispatches — inside one
 * `BEGIN IMMEDIATE` transaction (see `insert_run_and_adopt` in the Rust store).
 * SQLite's write lock is the collision detector: two runs starting at once
 * serialize, the first adopts, and the second's UPDATE matches nothing.
 *
 * What it costs, stated plainly:
 *
 * - **First run takes all.** Concurrent orchestrators are supported (#4389), and
 *   a second run started against the same backlog now adopts zero tasks instead
 *   of sharing them. That is a real behavior change for multi-orchestrator
 *   workspaces, and it is the cost of making ownership unambiguous. It is only
 *   visible through run-filtered reads: unfiltered scheduling is unchanged.
 * - **Terminal tasks are never adopted.** Only `pending`/`ready`/`dispatched`/
 *   `blocked` tasks are live work. Stamping today's run onto a task that
 *   completed last month would make every run-scoped summary lie about what the
 *   run did.
 * - **Un-owned rows stay legal forever.** A `completed` task from a pre-v9
 *   install keeps `run_id = null` and still lists, because a null run filter
 *   means "no filter" everywhere, never "un-owned only".
 */
export class RunOwnershipStore {
  constructor(private store: RustOrchestrationStoreHandle) {}

  /**
   * Bounded run history, newest first — the supervisor wake brief's feed, and the
   * data behind the `orchestration.runList` RPC a later stage adds.
   *
   * Paginated at the SQL level on purpose: run history is unbounded and grows for
   * the life of an install, so a read-everything-then-slice shim would get slower
   * forever and marshal the whole table across napi to show ten rows.
   */
  list(options: { limit?: number; offset?: number } = {}): CoordinatorRun[] {
    return listFromJson<CoordinatorRun>(
      this.store.listCoordinatorRuns(options.limit ?? 20, options.offset ?? 0)
    )
  }
}
