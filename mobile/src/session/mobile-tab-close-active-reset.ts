/**
 * After a tab close succeeds, decide whether the active-identity refs
 * (active tab id/type + live terminal handle) must be reset to null.
 *
 * Reset when the closed tab was the active one, or when nothing remains:
 * closing the final tab must never leave a stale terminal handle live,
 * even during a bulk close where the anchor was re-activated onto the very
 * tab now being closed (so `activeTabId === closedTabId` is already false).
 */
export function shouldResetActiveIdentityAfterClose(
  activeTabId: string | null,
  closedTabId: string,
  remainingTabCount: number
): boolean {
  return activeTabId === closedTabId || remainingTabCount === 0
}
