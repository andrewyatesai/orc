// TS dispatch for the fleet-exceptions parity module: drives the LIVE
// src/renderer/src/components/alab/fleet-exceptions.ts against the Rust port
// (orca_core::fleet_exceptions).
//
// The decision under test is the COLLAPSE KEY. An earlier bug keyed the collapse
// on the run instead of the task, so a run with twelve stuck tasks rendered as
// one row and eleven blocked tasks were invisible to the supervisor. The corpus
// carries several exceptions from one run across different tasks precisely so a
// re-introduction of that key shows up on both sides at once.
//
// The module is pure and imports nothing from React, so the live source is
// imported directly — no component harness, no DOM.

import {
  EXCEPTION_SOURCE_STATUS,
  collapseExceptionsByTask,
  unwiredExceptionSources,
  type FleetException,
  type FleetExceptionKind
} from '../../../src/renderer/src/components/alab/fleet-exceptions'

const KINDS: readonly string[] = [
  'gate',
  'escalation',
  'circuit-broken',
  'lifecycle-rejected',
  'attention',
  'unanswered-ask'
]

/** A wrong-typed field reads as absent. `String(x ?? '')` coerced `41` to `'41'`
 *  while the Rust adapter's `as_str()` gave `''`, so the two sides were compared
 *  on different task ids. */
function stringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value : ''
}

/**
 * `null` for a kind outside §8.3's six. TS would index SEVERITY with it and get
 * `undefined` — every comparison false, the sort comparator NaN — which is not a
 * behaviour either side should be asserted to reproduce, so both adapters refuse
 * the row instead.
 */
function toException(raw: Record<string, unknown>): FleetException | null {
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  if (!KINDS.includes(kind)) {
    return null
  }
  return {
    taskId: stringField(raw, 'taskId'),
    kind: kind as FleetExceptionKind,
    summary: stringField(raw, 'summary'),
    // Absent and explicit null are the same "no worker", matching the Rust
    // adapter's `Option<String>`.
    workerHandle: typeof raw.workerHandle === 'string' ? raw.workerHandle : null,
    // Safe integers only: a fraction, or a magnitude past 2**53, is a number the
    // two sides cannot agree they were even handed (Rust reads i64, TS reads
    // f64), so both adapters read it as absent rather than assert a false match.
    attempts: Number.isSafeInteger(raw.attempts) ? (raw.attempts as number) : 0,
    at: stringField(raw, 'at')
  }
}

export function dispatch(fn: string, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>
  switch (fn) {
    case 'collapseExceptionsByTask': {
      const rows = Array.isArray(args.exceptions) ? args.exceptions : []
      const parsed = rows.map((row) => toException((row ?? {}) as Record<string, unknown>))
      if (parsed.some((row) => row === null)) {
        return { __parity_error__: 'unknown FleetExceptionKind' }
      }
      return collapseExceptionsByTask(parsed as FleetException[])
    }
    case 'unwiredExceptionSources':
      return unwiredExceptionSources()
    // Ordered projection of the status object: pins the six keys AND their
    // declaration order, which is the order Object.keys — and therefore
    // unwiredExceptionSources — reports in.
    case 'exceptionSourceStatuses':
      return Object.entries(EXCEPTION_SOURCE_STATUS).map(([kind, status]) => ({ kind, status }))
    default:
      return { __parity_error__: `unknown function ${fn}` }
  }
}
