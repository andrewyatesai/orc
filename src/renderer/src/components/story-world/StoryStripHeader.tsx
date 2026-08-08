/**
 * Story World's `titlebar-strip` capsule — `docs/reference/app-modes.md` §7.1.
 *
 * **This exists because of one rule.** Story World gates off the nav, the status
 * bar, the tabs and the right sidebar, and it replaces the sidebar body — so
 * without this strip the only ways out are the menu bar (auto-hidden on Windows
 * and Linux until Alt is pressed) and a keyboard shortcut. The one mode aimed at
 * a user who cannot read must not be the one mode with no in-window escape.
 *
 * The world-name pill IS the escape: tapping it opens Settings, where the mode
 * picker lives. §2.6 makes Settings structurally unhideable, so this route
 * cannot be gated off by any manifest.
 *
 * Press-and-hold rather than a plain click for the grown-up route, so a child
 * exploring by tapping does not land in an adult surface by accident.
 */

import { useCallback, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/** Long enough that a curious tap does not trigger it, short enough that an
 *  adult does not think it is broken. */
const HOLD_MS = 800

export type StoryStripHeaderProps = {
  worldName?: string
}

export default function StoryStripHeader({ worldName }: StoryStripHeaderProps): React.JSX.Element {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHold = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }, [])

  const beginHold = useCallback(() => {
    cancelHold()
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null
      openSettingsPage()
    }, HOLD_MS)
  }, [cancelHold, openSettingsPage])

  return (
    <div className="flex items-center gap-3 px-3" data-testid="story-world-strip">
      <span className="truncate text-base font-medium">
        {worldName || translate('storyWorld.strip.untitled', 'My world')}
      </span>

      {/* The always-available escape. A single click is enough here: this is the
          way OUT, and making the exit hard to find is the failure mode. */}
      <button
        type="button"
        className="ml-auto flex h-12 items-center gap-2 rounded-lg border px-4 text-base"
        onClick={() => openSettingsPage()}
        onPointerDown={beginHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        data-testid="story-world-grownup"
      >
        <span aria-hidden="true" className="size-3 rounded-full bg-foreground/70" />
        <span>{translate('storyWorld.strip.grownUp', 'Show a grown-up')}</span>
      </button>
    </div>
  )
}
