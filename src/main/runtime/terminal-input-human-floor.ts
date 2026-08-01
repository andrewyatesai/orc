/**
 * §5.4's human input claim, shaped to compose with the runtime's real mobile
 * input floor (`beginMobileInputFloor` → `{ commit, rollback }`): the pane is
 * reserved *before* the write is attempted — check-then-subscribe is not a
 * linearization point — and only the outcome of that write decides whether the
 * automated writer it displaced actually lost the pane.
 *
 * Three states, because two cannot express "reserved but undecided": a claim
 * that is rolled back (rejected write, orphaned client, guard refusal) must
 * leave a live operation live.
 */
import type {
  AutomatedWriter,
  LeaseRevokedReport,
  LeaseWritePhase
} from './terminal-input-lease-preemption'

/** The automated operation a claim displaced, known before its fate is. */
export type SuspendedOperation = {
  operationId: string
  writer: AutomatedWriter
  phase: LeaseWritePhase
}

export type HumanInputFloorClaim = {
  /** What the reservation suspended — provisional until commit() or rollback(). */
  suspended: SuspendedOperation | null
  /** The human write landed: stamps the takeover report (§5.4's phase table) and
   *  holds the pane against automation until release(). */
  commit(): LeaseRevokedReport | null
  /** The human write never landed: the suspended writer keeps the pane. */
  rollback(): void
  /** Ends a committed floor. Before commit() this is a rollback, so a caller that
   *  drops a claim without deciding cannot park the pane forever. */
  release(): void
}

export type HumanInputFloorTransitions = {
  commit: () => LeaseRevokedReport | null
  rollback: () => void
  releaseCommitted: () => void
}

export function createHumanInputFloorClaim(
  suspended: SuspendedOperation | null,
  transitions: HumanInputFloorTransitions
): HumanInputFloorClaim {
  let decided = false
  let committed = false
  let releasedFloor = false
  const rollback = (): void => {
    if (decided) {
      return
    }
    decided = true
    transitions.rollback()
  }
  return {
    suspended,
    commit: () => {
      if (decided) {
        return null
      }
      decided = true
      committed = true
      return transitions.commit()
    },
    rollback,
    release: () => {
      if (!decided) {
        rollback()
        return
      }
      if (!committed || releasedFloor) {
        return
      }
      releasedFloor = true
      transitions.releaseCommitted()
    }
  }
}

/** §5.4's post-human hold-off. Without it a writer queued behind the preemption
 *  pastes over a half-typed line on the very tick the preempted writer
 *  acknowledges; every fresh keystroke restarts it. */
export function openHumanQuietWindow(
  pane: { cancelQuietWindow: (() => void) | null },
  window: {
    delayMs: number
    schedule: (end: () => void, delayMs: number) => () => void
    onEnd: () => void
  }
): void {
  pane.cancelQuietWindow?.()
  pane.cancelQuietWindow = null
  if (window.delayMs <= 0) {
    window.onEnd()
    return
  }
  let cancel: (() => void) | null = null
  const end = (): void => {
    // A superseded timer that fires late must not reopen the pane.
    if (pane.cancelQuietWindow !== cancel) {
      return
    }
    pane.cancelQuietWindow = null
    window.onEnd()
  }
  cancel = window.schedule(end, window.delayMs)
  pane.cancelQuietWindow = cancel
}
