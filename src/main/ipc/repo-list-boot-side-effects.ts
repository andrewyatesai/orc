/** Seam between repos:list and the startup snapshot.
 *
 *  repos:list performs folder→git promotion (issue #8125) and git-identity /
 *  username enrichment as side effects. The boot chain now reads the catalog
 *  from the startup snapshot with zero repos:list round-trips, so the snapshot
 *  handler replays the exact same effects through the runner that
 *  registerRepoHandlers installs here — once per snapshot request, before the
 *  repos are captured, so promotions land in the boot payload.
 *
 *  One effect is not replayed inline: promotion's `git rev-parse` probe. Only
 *  git can decide whether a `.git` marker is a repository, and its probe spawns
 *  synchronously — which would stall the whole snapshot (settings, ui,
 *  keybindings, session…) for every consumer. So the snapshot path only triages
 *  candidates (one stat each) and schedules the probe for after the renderer is
 *  up; a promotion it makes reaches the renderer through the repos:changed
 *  broadcast the renderer already refetches on. */

/** Runs every boot side effect except promotion's git probe, and hands that
 *  probe back as a callable for off-critical-path scheduling — null when the
 *  spawn-free marker pass already settled every folder repo. */
export type RepoListSideEffectsRunner = () => (() => void) | null

/** Long enough for the renderer to have mounted and attached its repos:changed
 *  listener (measured boot: workspace ready ~0.5s, first terminal frame ~1s).
 *  The broadcast is fire-and-forget with no buffering, so a probe that promoted
 *  a row before that listener existed would strand the row until some later
 *  repos:list. Nothing waits on this repair, so paying the delay costs nothing. */
const BOOT_GIT_PROBE_DELAY_MS = 2_000

let runner: RepoListSideEffectsRunner | null = null
let bootGitProbeInFlight = false
let bootGitProbeTimer: ReturnType<typeof setTimeout> | null = null

/** Installed by registerRepoHandlers (which owns the store + main window the
 *  effects need); re-installation on macOS window re-creation just swaps the closure. */
export function setRepoListSideEffectsRunner(next: RepoListSideEffectsRunner | null): void {
  runner = next
  // Cancel the pending probe rather than only clearing the flag: it closed over
  // the PREVIOUS window's runner, and leaving it queued while the flag says
  // "free" would let both it and the new window's probe run.
  if (bootGitProbeTimer) {
    clearTimeout(bootGitProbeTimer)
    bootGitProbeTimer = null
  }
  bootGitProbeInFlight = false
}

/** No-op until registerRepoHandlers runs — it does before the renderer loads,
 *  so a real boot snapshot always finds the runner installed.
 *
 *  Returns as soon as the spawn-free work is done; the git probe runs on a
 *  timer. Nothing is persisted to mark the probe as attempted, so an app closed
 *  mid-boot simply re-derives the same candidates from disk next boot. */
export function runRepoListSideEffectsForStartupSnapshot(): void {
  const probeGitCandidates = runner?.() ?? null
  if (!probeGitCandidates || bootGitProbeInFlight) {
    // Why: a queued probe re-triages from the live store when the runner runs,
    // so dropping this request's callable cannot lose a promotion that still
    // needs one — it only avoids spawning git twice for the same boot.
    return
  }
  bootGitProbeInFlight = true
  const timer = setTimeout(() => {
    bootGitProbeTimer = null
    try {
      probeGitCandidates()
    } catch (error) {
      console.warn('[repo-kind] Deferred boot git promotion failed:', error)
    } finally {
      bootGitProbeInFlight = false
    }
  }, BOOT_GIT_PROBE_DELAY_MS)
  bootGitProbeTimer = timer
  // Why: a background repair must never hold the app open at quit — the next
  // boot re-derives the same candidates from disk.
  timer.unref?.()
}
