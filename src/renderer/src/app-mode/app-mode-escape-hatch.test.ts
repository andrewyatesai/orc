/**
 * §2.6 and §12: no build may contain a way to ENTER a mode that it does not also
 * contain a way to LEAVE, and no mode may gate itself out of the mode picker.
 *
 * This is the invariant with the worst failure mode in the whole feature — a
 * user stuck in a mode they cannot read their way out of — and it is invisible
 * from a developer machine where the menu bar is always visible.
 */
import { describe, expect, it } from 'vitest'
import { APP_MODE_OPTIONS, type AppModeId } from '../../../shared/app-mode/app-mode-id'
import { APP_SURFACE_IDS } from '../../../shared/app-mode/app-mode-surfaces'
import { resolveModeCapsule } from '../../../shared/app-mode/app-mode-capability'
import { isKeybindingActionAllowed } from './app-shell-chrome-state'

const MODE_IDS: AppModeId[] = APP_MODE_OPTIONS.map((option) => option.id)

describe('every mode has a way out', () => {
  it('no surface can gate Settings or the menus', () => {
    // Settings reachability is STRUCTURAL: it is not a surface, so no manifest
    // can turn it off.
    for (const surface of APP_SURFACE_IDS) {
      expect(surface).not.toMatch(/^view\.settings$|^menu\./)
    }
  })

  it.each(MODE_IDS)('%s keeps the Settings keyboard shortcut', (mode) => {
    expect(isKeybindingActionAllowed(mode, 'app.settings')).toBe(true)
  })

  it('a mode that hides the chrome a non-reader uses must own the titlebar strip', () => {
    // Story World gates off nav, status bar, tabs and the right sidebar AND
    // replaces the sidebar body. The menu bar is auto-hidden on Windows/Linux
    // until Alt, and a keyboard shortcut is no route for a six-year-old — so an
    // in-window control is the only real escape.
    for (const mode of MODE_IDS) {
      const replacesSidebar = resolveModeCapsule(mode, 'left-sidebar-body') !== null
      const replacesBody = resolveModeCapsule(mode, 'workspace-body') !== null
      const hidesNavChrome = !isKeybindingActionAllowed(mode, 'sidebar.right.toggle')
      if (replacesSidebar && replacesBody && hidesNavChrome) {
        expect({ mode, hasStrip: resolveModeCapsule(mode, 'titlebar-strip') !== null }).toEqual({
          mode,
          hasStrip: true
        })
      }
    }
  })

  it('Classic occupies no slot, so it cannot be the mode you get stuck in', () => {
    for (const slot of ['workspace-body', 'left-sidebar-body', 'titlebar-strip'] as const) {
      expect(resolveModeCapsule('classic', slot)).toBeNull()
    }
  })
})
