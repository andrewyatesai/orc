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
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { rebuildAppMenu } from '../menu/register-app-menu'
import type { AppModeId } from '../../shared/app-mode/app-mode-id'
import { resolveModeManifest } from '../../shared/app-mode/app-mode-capability'

export function applyAppModeChange(before: AppModeId, after: AppModeId): void {
  if (before === after) {
    return
  }
  // Electron menus are not reactive: the radio check state and any mode-varying
  // items only update when the template is rebuilt.
  rebuildAppMenu()
  applyAppIcon(resolveModeManifest(after).appIcon)
  // A 30-entry ring, so the switch itself lands in the pre-crash trail — which
  // is exactly where a mode-transition bug shows up.
  recordCrashBreadcrumb('mode_changed', { from: before, to: after })
}
