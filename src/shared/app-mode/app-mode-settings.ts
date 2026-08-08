/**
 * Mode-private settings — `docs/reference/app-modes.md` §2.7.
 *
 * Namespaced under one `appModeSettings` key rather than adding ~22 members to
 * an already-flat ~430-key `GlobalSettings`. Each mode's block renders in the
 * Settings pane only while that mode is active, but its search entries carry the
 * mode as a keyword so Cmd+J can still find them from anywhere.
 */

export type AlabSettings = {
  /**
   * Clamped by the caller to the runtime's reported ask long-poll share
   * (`LONG_POLL_CAP 16 x ASK_LONG_POLL_SHARE 0.5 = 8`). A larger fleet has
   * workers whose questions are refused with `runtime_busy`, and BEHAVIOR RULE
   * #1 forbids their only fallback.
   */
  readonly defaultMaxConcurrent?: number
}

export type StoryWorldSettings = {
  /** 0 disables auto-saves and also hides the restore button, rather than
   *  leaving it present-and-failing. */
  readonly autoSaveCount?: number
}

export type AppModeSettings = {
  readonly alab?: AlabSettings
  readonly storyWorld?: StoryWorldSettings
}
