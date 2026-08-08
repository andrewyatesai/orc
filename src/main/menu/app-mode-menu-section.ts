/**
 * The `View ▸ Mode` radio group — `docs/reference/app-modes.md` §3.3.
 *
 * **Its own module is mandatory, not stylistic.** `register-app-menu.ts` is
 * already over its counted line budget's comfort margin, it is verified absent
 * from `config/max-lines-baseline.txt`, `AGENTS.md` forbids adding a disable,
 * and the ratchet fails `pnpm lint` on any new baseline entry — with no CI to
 * catch it later.
 *
 * **Placement: below Appearance, after a separator.** Not a new top-level menu —
 * the template is the most visible thing in the app. Below rather than above
 * Appearance because Appearance is a checkbox group where a stray click costs
 * one toggle, whereas a one-row misclick into the mode radios reconfigures the
 * whole product.
 *
 * **No accelerator.** This file's convention is display-only `\t` hints, because
 * a real menu accelerator intercepts the chord in main before the renderer's
 * `before-input-event` carve-outs run. If one is ever added it must be
 * `CmdOrCtrl`, never `metaKey`.
 */

import { APP_MODE_OPTIONS, type AppModeId } from '../../shared/app-mode/app-mode-id'
import type { AppModeSource } from '../../shared/app-mode/resolve-app-mode'
import { isAppModeSelectionLocked } from '../../shared/app-mode/resolve-app-mode'

/** English fallbacks live beside the keys, matching `translateMain`'s shape. */
const MODE_LABELS: Record<AppModeId, { key: string; fallback: string }> = {
  classic: { key: 'menu.mode.classic', fallback: 'Orca Classic' },
  alab: { key: 'menu.mode.alab', fallback: 'ALab' },
  'story-world': { key: 'menu.mode.storyWorld', fallback: 'Story World' }
}

const SOURCE_NOTES: Partial<Record<AppModeSource, { key: string; fallback: string }>> = {
  env: { key: 'menu.mode.lockedByEnv', fallback: 'Set by ORCA_APP_MODE for this session' },
  lock: { key: 'menu.mode.lockedByFile', fallback: 'Locked in app-mode.json' }
}

export type AppModeMenuOptions = {
  current: AppModeId
  source: AppModeSource
  onSelect: (mode: AppModeId) => void
  translate: (key: string, fallback: string) => string
}

/**
 * Electron enforces mutual exclusion within a contiguous run of `radio` items,
 * so the three modes must stay adjacent with no separator between them.
 */
export function buildAppModeSubmenu(
  options: AppModeMenuOptions
): Electron.MenuItemConstructorOptions {
  const locked = isAppModeSelectionLocked(options.source)
  const items: Electron.MenuItemConstructorOptions[] = APP_MODE_OPTIONS.map((option) => {
    const label = MODE_LABELS[option.id]
    return {
      label: options.translate(label.key, label.fallback),
      type: 'radio' as const,
      checked: option.id === options.current,
      // Disabled rather than hidden when a higher rung wins: a selector that
      // silently does nothing is worse than one that visibly cannot.
      enabled: !locked,
      click: () => options.onSelect(option.id)
    }
  })

  const note = locked ? SOURCE_NOTES[options.source] : undefined
  if (note) {
    items.push(
      { type: 'separator' },
      { label: options.translate(note.key, note.fallback), enabled: false }
    )
  }

  return {
    label: options.translate('menu.mode', 'Mode'),
    submenu: items
  }
}
