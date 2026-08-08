/**
 * The single owner of app-mode side effects — `docs/reference/app-modes.md`
 * §3.6. Called from all three write paths (menu, Settings pane, sidecar file).
 *
 * Its own module because `ipc/settings.ts` is already near its line cap and
 * should not absorb this.
 *
 * **`rebuildAppMenu()` must fire on EVERY path.** The existing
 * `APPEARANCE_MENU_KEYS` mechanism is consulted only inside the `settings:set`
 * handler body, so it could never fire for the menu-originated or
 * file-watcher-originated write. Do not reach for it; call this instead.
 *
 * Fan-out to renderers is NOT done here — it rides the existing
 * `onSettingsChanged` broadcast, so there are zero new IPC channels.
 */

import { applyAppIcon } from '../app-icon'
import { DEFAULT_APP_ICON_ID, normalizeAppIconId } from '../../shared/app-icon'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { rebuildAppMenu } from '../menu/register-app-menu'
import type { AppModeId } from '../../shared/app-mode/app-mode-id'
import { resolveModeManifest } from '../../shared/app-mode/app-mode-capability'

export function applyAppModeChange(
  before: AppModeId,
  after: AppModeId,
  /** The user's own `settings.appIcon`. Required so a mode can never silently
   *  replace it — see below. */
  userAppIcon?: unknown
): void {
  if (before === after) {
    return
  }
  // Electron menus are not reactive: the radio check state and any mode-varying
  // items only update when the template is rebuilt.
  rebuildAppMenu()
  applyAppIconForMode(after, userAppIcon)
  // A 30-entry ring, so the switch itself lands in the pre-crash trail — which
  // is exactly where a mode-transition bug shows up.
  recordCrashBreadcrumb('mode_changed', { from: before, to: after })
}

/**
 * §2.5: **a mode never overrides a settings value.**
 *
 * Applying `manifest.appIcon` unconditionally violated that. Every manifest
 * currently carries `DEFAULT_APP_ICON_ID`, so a user who had chosen a different
 * App Icon lost it on ANY mode switch — and on a packaged macOS build
 * `applyAppIcon('classic')` also clears the installed bundle's Finder/Dock icon
 * metadata on disk. Returning to Classic did not restore it, because Classic's
 * manifest applies the same default, so `settings.appIcon` and the visible icon
 * disagreed until the next launch. That made the round trip lossy.
 *
 * The rule that satisfies both §2.5 and §3.6: a mode may apply an icon only when
 * it actually declares a DISTINCT one. Otherwise the user's choice stands.
 */
function applyAppIconForMode(mode: AppModeId, userAppIcon: unknown): void {
  const manifestIcon = resolveModeManifest(mode).appIcon
  if (manifestIcon !== DEFAULT_APP_ICON_ID) {
    applyAppIcon(manifestIcon)
    return
  }
  // The mode has no opinion, so the user's does.
  applyAppIcon(normalizeAppIconId(userAppIcon))
}
