/** Seam between repos:list and the startup snapshot.
 *
 *  repos:list performs folder→git promotion (issue #8125) and git-identity /
 *  username enrichment as side effects. The boot chain now reads the catalog
 *  from the startup snapshot with zero repos:list round-trips, so the snapshot
 *  handler replays the exact same effects through the runner that
 *  registerRepoHandlers installs here — once per snapshot request, before the
 *  repos are captured, so promotions land in the boot payload. */

let runner: (() => void) | null = null

/** Installed by registerRepoHandlers (which owns the store + main window the
 *  effects need); re-installation on macOS window re-creation just swaps the closure. */
export function setRepoListSideEffectsRunner(next: (() => void) | null): void {
  runner = next
}

/** No-op until registerRepoHandlers runs — it does before the renderer loads,
 *  so a real boot snapshot always finds the runner installed. */
export function runRepoListSideEffectsForStartupSnapshot(): void {
  runner?.()
}
