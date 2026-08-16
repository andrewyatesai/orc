// The ALab exceptions queue's reducer, resolved by `orca_core::fleet_exceptions`
// through the renderer's orca-git wasm. The twin
// (`src/renderer/src/components/alab/fleet-exceptions.ts`) keeps the row types,
// the `EXCEPTION_SEVERITY` ranking and the `EXCEPTION_SOURCE_STATUS` table as
// data — `ExceptionsQueue` renders `kind` straight out of a row, and the parity
// corpus's `exceptionSourceStatuses` case compares that TS table against the
// Rust one, which is what stops the two copies drifting.
//
// On the git-wasm binding rather than the orca-dispatch seam because the
// renderer is the only surface that has ever collapsed an exception: main
// classifies and task-keys the rows (`alab.consoleSnapshot`) and never reduces
// them, and `ExceptionsQueue` is lazy-loaded by `app-mode/ModeCapsuleSlot`. A
// local runtime and an SSH/relay runtime make no difference — the rows arrive
// over the same RPC and are collapsed here either way.
//
// PRE-READY CONTRACT — `parity`, with a sentinel REFUSED on the evidence:
//  * A pre-ready `[]` is the silent-failure case, not a cosmetic one.
//    `ExceptionsQueue` prints "Nothing is waiting on you." whenever the poll has
//    succeeded (`loadedAt !== null`) and the collapsed list is empty, so an
//    empty pre-ready answer tells a supervisor the fleet is clear while a gate
//    is open — the one sentence that component's own comment calls the most
//    dangerous thing this console can print.
//  * A `null` sentinel is honest but costs the panel.
//    `awaitGitWasmReadyForStartupHydration` gates hydration, so a mode capsule
//    mounted long after boot finding the core not-ready has found a core that
//    FAILED: the fallback is the whole session, not a blip. That would leave the
//    one panel whose job is "nothing is hidden from you" showing nothing at all,
//    unattended, for as long as the window is open.
//  * The rows are already in hand and the reduction is pure, so the fallback
//    recomputes the deleted body and the queue keeps working either way. Nothing
//    it returns is persisted, and `ExceptionsQueue`'s React key is the row's own
//    `taskId`, which is identical on both paths — so no caller can tell the two
//    states apart, and none has to subscribe to the ready edge.
//
// PROVEN, not assumed: 60,156 differential probes of this fallback against the
// SHIPPED `orca_git_wasm_bg.wasm` agree on every input — every sequence of
// length <= 3 over the 12 (kind, timestamp) templates, both orderings of every
// two-task pair, and ~58k random rows carrying empty strings, an astral `at`,
// U+E000, soft hyphen, BOM, combining marks, NFC/NFD task ids, and negative and
// 2**53-1 attempt counts.
//
// EIGHT MEASURED DIVERGENCE CLASSES, each folded back by `isCrossable` below
// rather than shipped. They are all off-type or out-of-range rows, which the
// `FleetException` type forbids but the wire can still deliver, since the poll
// types `kind` as a bare `string` and `ExceptionsQueue` casts it:
//   kind outside the six      core refuses the batch, the twin sorts it with a
//                             NaN comparator (arrival order, V8-defined)
//   fractional attempts       core reads 0, the twin keeps 1.5
//   |attempts| past 2**53     core reads 0, the twin keeps the float
//   sum past 2**53            the twin rounds at every add, the core once at the
//                             end: 2**53-1 + 2 + 1 is 2**53 here, 2**53+2 there
//   non-string taskId/at      core reads '', the twin keeps the number
//   absent workerHandle       core answers null, the twin omits the key
//   an extra own key          core drops it, the twin spreads it through
//   a null row                core refuses the batch, the twin throws TypeError
// A lone UTF-16 surrogate in any field is the ninth: the codec refuses to encode
// it, which is caught below.
import {
  EXCEPTION_SEVERITY,
  EXCEPTION_SOURCE_STATUS,
  type FleetException,
  type FleetExceptionKind
} from '../../components/alab/fleet-exceptions'
import { DispatchPayloadError } from '../../../../shared/dispatch-payload-codec'
import { isGitWasmReady } from './git-wasm-availability'
import { dispatchToWasmCore } from './wasm-core-dispatch'

const FLEET_EXCEPTIONS = 'fleet-exceptions'

/** Newest first, by code-unit order — the SAME comparison the merge uses, so one
 *  module cannot rank a pair of timestamps two ways. */
function compareAtDescending(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return left < right ? 1 : -1
}

/** The deleted twin's body, verbatim over the kept severity table. */
function legacyCollapseExceptionsByTask(raw: readonly FleetException[]): FleetException[] {
  const byTask = new Map<string, FleetException>()
  for (const exception of raw) {
    const existing = byTask.get(exception.taskId)
    if (!existing) {
      byTask.set(exception.taskId, { ...exception })
      continue
    }
    // On a tie the newer row wins: strictly-greater would leave a task showing
    // the stale 10:00 summary of two escalations at 10:00 and 12:00, and sorting
    // by that timestamp then ranks it below fresher, less urgent work.
    const higher = EXCEPTION_SEVERITY[exception.kind] > EXCEPTION_SEVERITY[existing.kind]
    const sameSeverityButNewer =
      EXCEPTION_SEVERITY[exception.kind] === EXCEPTION_SEVERITY[existing.kind] &&
      exception.at > existing.at
    const winner = higher || sameSeverityButNewer ? exception : existing
    byTask.set(exception.taskId, {
      ...winner,
      // Attempts and recency survive the merge regardless of which row won: the
      // count is about the task, and a lower-severity but newer row still means
      // the task moved, which is what the sort's tiebreak needs to know.
      attempts: existing.attempts + exception.attempts,
      at: exception.at > existing.at ? exception.at : existing.at
    })
  }
  return [...byTask.values()].sort((left, right) => {
    const bySeverity = EXCEPTION_SEVERITY[right.kind] - EXCEPTION_SEVERITY[left.kind]
    return bySeverity !== 0 ? bySeverity : compareAtDescending(left.at, right.at)
  })
}

/** The deleted twin's body over the kept status table. */
function legacyUnwiredExceptionSources(): FleetExceptionKind[] {
  return (Object.keys(EXCEPTION_SOURCE_STATUS) as FleetExceptionKind[]).filter(
    (kind) => EXCEPTION_SOURCE_STATUS[kind] === 'not-yet'
  )
}

/** A row the core reads exactly as the fallback does — see the divergence table
 *  in the header for what each clause excludes and what it costs. */
function isCrossableRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) {
    return false
  }
  const candidate = row as Record<string, unknown>
  return (
    // The core projects the six §8.3 fields and drops anything else.
    Object.keys(candidate).length === 6 &&
    typeof candidate.taskId === 'string' &&
    typeof candidate.summary === 'string' &&
    typeof candidate.at === 'string' &&
    (candidate.workerHandle === null || typeof candidate.workerHandle === 'string') &&
    Object.hasOwn(EXCEPTION_SEVERITY, candidate.kind as string) &&
    Number.isSafeInteger(candidate.attempts)
  )
}

function isCrossable(raw: readonly FleetException[]): boolean {
  let attemptBudget = Number.MAX_SAFE_INTEGER
  for (const row of raw) {
    if (!isCrossableRow(row)) {
      return false
    }
    // Bounding the TOTAL, not each row: JS rounds at every `+` and Rust sums
    // exactly, so only a merged count that stays under 2**53 is the same number.
    attemptBudget -= Math.abs(row.attempts)
    if (attemptBudget < 0) {
      return false
    }
  }
  return true
}

/** One row per task — most severe kind wins, `attempts` counts everything that
 *  collapsed into it, ordering is severity then recency. Collapse happens BEFORE
 *  ordering, so a task showing `circuit-broken` is never represented by its
 *  earliest `escalation`. */
export function collapseExceptionsByTask(raw: readonly FleetException[]): FleetException[] {
  if (!isGitWasmReady() || !isCrossable(raw)) {
    return legacyCollapseExceptionsByTask(raw)
  }
  try {
    const answer = dispatchToWasmCore(FLEET_EXCEPTIONS, 'collapseExceptionsByTask', {
      exceptions: raw
    })
    // Not `as FleetException[]`: an unexpected answer shape must degrade to the
    // fallback, never render as the operator's exception list.
    return Array.isArray(answer)
      ? (answer as FleetException[])
      : legacyCollapseExceptionsByTask(raw)
  } catch (error) {
    // Why the catch: `summary` is worker-authored text and every field crosses an
    // RPC, so any of them can carry a lone UTF-16 surrogate the codec refuses to
    // encode. The twin answered those without crossing, so the fallback does too;
    // a DispatchCoreError still propagates.
    if (error instanceof DispatchPayloadError) {
      return legacyCollapseExceptionsByTask(raw)
    }
    throw error
  }
}

/** The §8.3 sources this build does NOT read, in `EXCEPTION_SOURCE_STATUS` key
 *  order — `ExceptionsQueue` turns a non-empty answer into the caveat line that
 *  stops an empty queue reading as "all clear". */
export function unwiredExceptionSources(): FleetExceptionKind[] {
  if (!isGitWasmReady()) {
    return legacyUnwiredExceptionSources()
  }
  return dispatchToWasmCore(
    FLEET_EXCEPTIONS,
    'unwiredExceptionSources',
    undefined
  ) as FleetExceptionKind[]
}
