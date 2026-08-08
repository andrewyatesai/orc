/**
 * Black-screen recovery — `docs/reference/app-modes.md` §7.5.
 *
 * Exactly two buttons, no stack trace, no path, no line number. A six-year-old
 * cannot describe a bug, so the app describes it and she only has to agree.
 *
 * **Suppressed entirely while the agent is working.** A mid-turn reload against
 * a half-written tree is normal; showing this card three times per request would
 * train her to ignore it, which costs more than never showing it at all.
 */

import { translate } from '@/i18n/i18n'
import { isChildSafeCopy, type StoryStatusWord } from './story-world-copy'

export type StoryStuckCardProps = {
  status: StoryStatusWord
  /** The raw message, if any. Never rendered — only forwarded to the agent. */
  detail?: string | null
  onTellClaude: (sentence: string) => void
  /** Absent when there is no save to go back to; the button is then hidden
   *  rather than present-and-failing (§7.5). */
  onRestoreLastGood?: (() => void) | null
}

export function StoryStuckCard({
  status,
  detail,
  onTellClaude,
  onRestoreLastGood
}: StoryStuckCardProps): React.JSX.Element | null {
  // Only when actually stuck, and never mid-turn.
  if (status !== 'Stuck') {
    return null
  }

  const tell = (): void => {
    // She agrees; the app does the describing. The raw detail is forwarded to
    // the AGENT (which can read it) but never shown on screen.
    const safeDetail = detail && isChildSafeCopy(detail) ? ` It says: ${detail}.` : ''
    onTellClaude(`My game is not working.${safeDetail} Please fix it.`)
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-lg border p-5"
      role="alertdialog"
      data-testid="story-world-stuck"
    >
      <p className="text-lg">{translate('storyWorld.stuck.title', 'Your game got stuck.')}</p>
      <div className="flex gap-3">
        <button type="button" className="h-12 rounded-lg border px-6 text-base" onClick={tell}>
          {translate('storyWorld.stuck.tell', 'Tell Claude')}
        </button>
        {onRestoreLastGood ? (
          <button
            type="button"
            className="h-12 rounded-lg border px-6 text-base"
            onClick={onRestoreLastGood}
          >
            {translate('storyWorld.stuck.restore', 'Go back')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
