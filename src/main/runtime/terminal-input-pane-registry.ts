/**
 * What the coordinator knows about one PTY's input, and how long it knows it.
 *
 * The pin is the pane's identity, not the writer's claim about it: only the
 * incarnation authority writes it (§5.1's `notePtyPin`), and an entry lives
 * exactly as long as something still depends on it — a live incarnation, a held
 * human floor, an unacknowledged holder, a queued waiter, a quiet window.
 * Anything else would let every ptyId that ever saw a refused acquire cost
 * memory for the life of the process.
 */
import type { ConnectionPin } from './terminal-input-lease-preemption'
import type { InputLeaseRecord } from './terminal-input-lease'

/** `pending` claims have reserved the pane but not yet landed a write. */
export type PaneHumanFloors = { pending: number; committed: number }

export type PtyInputState<TWaiter> = {
  ptyId: string
  /** Only the incarnation authority writes this. Retained after dispose so a
   *  reordered event from a superseded connection cannot rewind it. */
  pin: ConnectionPin | null
  /** False until an incarnation is announced, and again once it is disposed. */
  live: boolean
  active: InputLeaseRecord | null
  waiters: TWaiter[]
  floors: PaneHumanFloors
  cancelQuietWindow: (() => void) | null
}

export function createPaneState<TWaiter>(ptyId: string): PtyInputState<TWaiter> {
  return {
    ptyId,
    pin: null,
    live: false,
    active: null,
    waiters: [],
    floors: { pending: 0, committed: 0 },
    cancelQuietWindow: null
  }
}

/** Every human reason automation must wait: a reserved or committed input floor,
 *  and §5.4's quiet window after the human stopped typing. */
export function paneClosedToAutomation(state: {
  floors: PaneHumanFloors
  cancelQuietWindow: (() => void) | null
}): boolean {
  return state.floors.pending + state.floors.committed > 0 || state.cancelQuietWindow !== null
}

// Why: a disposed pane keeps its pin as a monotonic floor, so a reordered event from
// a superseded connection cannot rewind it and no writer can be granted a lease on a
// generation that has already passed. Those tombstones are all that remains of a dead
// pane, so bound them like the runtime's other per-pane LRUs.
export const DISPOSED_PANE_PIN_MEMORY_MAX = 256

export function reclaimPane<TWaiter>(
  panes: Map<string, PtyInputState<TWaiter>>,
  state: PtyInputState<TWaiter>
): void {
  const idle =
    !state.live &&
    !state.active &&
    state.waiters.length === 0 &&
    state.floors.pending + state.floors.committed === 0 &&
    !state.cancelQuietWindow
  if (!idle || panes.get(state.ptyId) !== state) {
    return
  }
  if (!state.pin) {
    panes.delete(state.ptyId)
    return
  }
  // Re-insert so the pin tombstone is youngest, then shed the oldest tombstones only —
  // a pane anything still depends on is never evicted.
  panes.delete(state.ptyId)
  panes.set(state.ptyId, state)
  let tombstones = 0
  for (const candidate of panes.values()) {
    if (candidate.pin && !candidate.live && !candidate.active) {
      tombstones += 1
    }
  }
  for (const candidate of panes.values()) {
    if (tombstones <= DISPOSED_PANE_PIN_MEMORY_MAX) {
      break
    }
    if (candidate.pin && !candidate.live && !candidate.active && candidate.waiters.length === 0) {
      panes.delete(candidate.ptyId)
      tombstones -= 1
    }
  }
}
