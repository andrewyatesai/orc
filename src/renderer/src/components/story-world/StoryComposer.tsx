/**
 * The child's own words — `docs/reference/app-modes.md` §7.2.
 *
 * **Story World does NOT reuse TerminalComposeBox**, and that is a correction
 * the design makes explicitly. That component is portaled INTO a pane, its
 * submit calls `onClose()` so it vanishes after every send, it opens only via a
 * chord or a right-click, it is gated on a setting, and its draft cache is a
 * bare Map with no subscribers — so writing to it while it is open changes
 * nothing on screen. Every one of those is wrong here: the parts strip writes
 * into this draft, and the child must WATCH her words appear.
 *
 * So this composer is always mounted, always visible, and its draft is real
 * state. It sends by calling back — it never types into a PTY itself, because
 * the pane portal owns that path.
 */

import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { isButtonLabelShortEnough } from './story-world-copy'

export type StoryComposerProps = {
  draft: string
  onDraftChange: (next: string) => void
  onSend: (text: string) => void
  /** Sending is refused while the agent is mid-turn: a second prompt on top of
   *  the first is how a child ends up with two half-built games. */
  canSend: boolean
}

export function StoryComposer({
  draft,
  onDraftChange,
  onSend,
  canSend
}: StoryComposerProps): React.JSX.Element {
  const trimmed = draft.trim()
  const send = useCallback(() => {
    if (trimmed.length > 0 && canSend) {
      onSend(trimmed)
    }
  }, [trimmed, canSend, onSend])

  return (
    <div className="flex items-end gap-2" data-testid="story-world-composer">
      <textarea
        className="min-h-[3.5rem] flex-1 rounded-lg border p-3 text-base"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter makes a new line. No chord footer is shown —
          // §7.8 bans the shell compose box's "⇧↩ newline · ⌘↩ stage · ↩ send".
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
        placeholder={translate('storyWorld.composer.placeholder', 'Tell Claude what you want')}
        aria-label={translate('storyWorld.composer.label', 'Tell Claude what you want')}
      />
      <button
        type="button"
        className="h-12 rounded-lg border px-5 text-base disabled:opacity-50"
        disabled={trimmed.length === 0 || !canSend}
        onClick={send}
      >
        {translate('storyWorld.composer.send', 'Send')}
      </button>
    </div>
  )
}

/** Exported for the copy test — the send label must obey the five-word rule. */
export const STORY_COMPOSER_SEND_LABEL = 'Send'
export function composerLabelObeysCopyRules(): boolean {
  return isButtonLabelShortEnough(STORY_COMPOSER_SEND_LABEL)
}
