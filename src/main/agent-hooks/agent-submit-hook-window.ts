import type { SubmitEvidenceOrigin } from './agent-submit-hook-observer'
import type { SuppressedClosedPaneHookRecord } from './closed-pane-hook-suppression'

/** Oldest-first eviction for an insertion-ordered LRU map. */
export function shedOldest<T>(
  entries: Map<string, T>,
  max: number,
  onShed?: (key: string, value: T) => void
): void {
  while (entries.size > max) {
    const oldest = entries.entries().next().value
    if (oldest === undefined) {
      return
    }
    entries.delete(oldest[0])
    onShed?.(oldest[0], oldest[1])
  }
}

/** Whether a recorded position falls inside the window an origin opens. */
export function isAfterOrigin(
  position: { sequence: number; at: number },
  origin: SubmitEvidenceOrigin
): boolean {
  return origin.sequence === undefined
    ? position.at >= origin.instant
    : position.sequence > origin.sequence
}

export function droppedSinceOrigin(
  drop: SuppressedClosedPaneHookRecord | undefined,
  origin: SubmitEvidenceOrigin
): boolean {
  if (!drop) {
    return false
  }
  if (origin.suppressedCount === undefined) {
    return drop.lastSuppressedAt >= origin.instant
  }
  return drop.count !== origin.suppressedCount || drop.lastSuppressedAt !== origin.suppressedAt
}
