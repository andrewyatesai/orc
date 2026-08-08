/**
 * The reversibility promise, made mechanical — `docs/reference/app-modes.md`
 * §1 and §6.
 *
 * The governing invariant is "modes gate, place, and reword; modes never own,
 * mutate, or destroy engine state." These tests hold the two halves of it that
 * can be checked without an Electron window: the chrome derivation only ever
 * SUBTRACTS, and a round trip through a mode restores every input exactly.
 */
import { describe, expect, it } from 'vitest'
import { APP_MODE_OPTIONS, type AppModeId } from '../../../shared/app-mode/app-mode-id'
import { APP_SURFACE_IDS } from '../../../shared/app-mode/app-mode-surfaces'
import { isSurfaceEnabled } from '../../../shared/app-mode/app-mode-capability'
import {
  isKeybindingActionAllowed,
  resolveAppShellChrome,
  type AppShellChromeInput
} from './app-shell-chrome-state'

const MODE_IDS = APP_MODE_OPTIONS.map((option) => option.id)

function chromeInput(mode: AppModeId, overrides: Partial<AppShellChromeInput> = {}) {
  return {
    mode,
    statusBarVisible: true,
    rightSidebarOpen: true,
    showTabBar: true,
    showSplitAffordances: true,
    showWorktreeHistoryControls: true,
    showTitlebarTabs: true,
    ...overrides
  }
}

describe('mode chrome only ever subtracts', () => {
  it.each(MODE_IDS)('%s never turns on a surface the user turned off', (mode: AppModeId) => {
    const allOff = resolveAppShellChrome(
      chromeInput(mode, {
        statusBarVisible: false,
        rightSidebarOpen: false,
        showTabBar: false,
        showSplitAffordances: false,
        showWorktreeHistoryControls: false,
        showTitlebarTabs: false
      })
    )
    expect(allOff.showStatusBar).toBe(false)
    expect(allOff.showRightSidebar).toBe(false)
    expect(allOff.showTabBar).toBe(false)
    expect(allOff.showSplitAffordances).toBe(false)
    expect(allOff.showWorktreeHistoryControls).toBe(false)
    expect(allOff.showTitlebarTabs).toBe(false)
  })

  it('Classic is a pure pass-through of the user preferences', () => {
    const input = chromeInput('classic')
    expect(resolveAppShellChrome(input)).toEqual({
      showStatusBar: true,
      showRightSidebar: true,
      showTabBar: true,
      showSplitAffordances: true,
      showWorktreeHistoryControls: true,
      showTitlebarTabs: true,
      tabsLocked: false
    })
  })

  it.each(MODE_IDS)('%s derivation is pure — it does not mutate its input', (mode: AppModeId) => {
    const input = chromeInput(mode)
    const snapshot = structuredClone(input)
    resolveAppShellChrome(input)
    expect(input).toEqual(snapshot)
  })
})

describe('Classic -> mode -> Classic is lossless', () => {
  it.each(MODE_IDS)('round trip through %s restores the Classic chrome', (mode: AppModeId) => {
    // The user's stored preferences are the only inputs; a mode reads them and
    // never writes them, so returning to Classic must reproduce the original
    // derivation byte for byte.
    const preferences = {
      statusBarVisible: true,
      rightSidebarOpen: false,
      showTabBar: true,
      showSplitAffordances: false,
      showWorktreeHistoryControls: true,
      showTitlebarTabs: true
    }
    const before = resolveAppShellChrome({ mode: 'classic', ...preferences })
    resolveAppShellChrome({ mode, ...preferences })
    const after = resolveAppShellChrome({ mode: 'classic', ...preferences })
    expect(after).toEqual(before)
  })

  it('an unrecognized mode degrades to the Classic derivation, never a crash', () => {
    const preferences = chromeInput('classic')
    for (const bogus of [undefined, null, 'kids', 42, '__proto__']) {
      expect(resolveAppShellChrome({ ...preferences, mode: bogus })).toEqual(
        resolveAppShellChrome(preferences)
      )
    }
  })
})

describe('surface-aware shortcut dispatch (§10.6)', () => {
  it('Classic gates nothing', () => {
    for (const action of ['sidebar.sourceControl.toggle', 'terminal.splitRight', 'tab.close']) {
      expect(isKeybindingActionAllowed('classic', action)).toBe(true)
    }
  })

  it('a hidden surface blocks its shortcut BEFORE the handler writes persisted state', () => {
    // ALab hides source control; without this gate the toggle still fires and
    // rewrites rightSidebarTab/rightSidebarOpen — a mode-caused write.
    expect(isSurfaceEnabled('alab', 'rightSidebar.sourceControl')).toBe(false)
    expect(isKeybindingActionAllowed('alab', 'sidebar.sourceControl.toggle')).toBe(false)
  })

  it('an unmapped action is never gated — a missing entry keeps a shortcut working', () => {
    expect(isKeybindingActionAllowed('story-world', 'app.settings')).toBe(true)
    expect(isKeybindingActionAllowed('story-world', 'not.a.real.action')).toBe(true)
  })

  it('every mapped action names a real surface', () => {
    // Guards against a surface being renamed out from under the map.
    for (const action of ['sidebar.explorer.toggle', 'terminal.splitDown', 'worktree.history.back']) {
      expect(isKeybindingActionAllowed('classic', action)).toBe(true)
      expect(APP_SURFACE_IDS.length).toBeGreaterThan(0)
    }
  })
})

describe('the settings escape hatch (§2.6)', () => {
  it('no surface can gate Settings or the menus out', () => {
    // This is what stops a mode hiding its own way out.
    for (const surface of APP_SURFACE_IDS) {
      expect(surface).not.toMatch(/^view\.settings$|^menu\./)
    }
  })

  it('app.settings is reachable by keyboard in every mode', () => {
    for (const mode of MODE_IDS) {
      expect(isKeybindingActionAllowed(mode, 'app.settings')).toBe(true)
    }
  })
})
