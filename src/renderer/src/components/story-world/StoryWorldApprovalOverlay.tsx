/**
 * What makes Ask-me-first usable for a non-reader — `docs/reference/app-modes.md`
 * §7.6.
 *
 * Without this, choosing Ask-me-first leaves a child facing the agent's raw TUI
 * menu ("1. Yes  2. Yes, don't ask again  3. No") as scrolling text — which
 * makes the guardrail decorative. A parent who selected the safer posture would
 * get LESS safety, because the child would learn to mash keys past a prompt she
 * cannot read.
 *
 * It composes the two decoupled primitives directly rather than reusing
 * NativeChatApprovalCard: that card's only mount point is gated on
 * `experimentalNativeChat` AND `viewMode === 'chat'`, so it can never render in
 * a terminal-mode centre band.
 *
 * §7.8 rule 5: never a question with more than two answers. The agent's third
 * option ("don't ask again") is deliberately NOT offered — a child cannot
 * consent to disabling her own guardrail.
 */

import { translate } from '@/i18n/i18n'
import { isChildSafeCopy } from './story-world-copy'

export type StoryApprovalChoice = { label: string; send: string }

export type StoryWorldApprovalOverlayProps = {
  /** Null when nothing is waiting — the overlay is absent, not empty. */
  approval: { title: string; detail?: string; options: StoryApprovalChoice[] } | null
  onRespond: (send: string) => void
}

/** The agent's own words are untrusted input here: they routinely contain paths
 *  and file names, which §7.8 bans outright from a child-facing surface. */
function safeTitle(title: string): string {
  return isChildSafeCopy(title)
    ? title
    : translate('storyWorld.approval.generic', 'Claude wants to change something. Is that OK?')
}

export function StoryWorldApprovalOverlay({
  approval,
  onRespond
}: StoryWorldApprovalOverlayProps): React.JSX.Element | null {
  if (!approval) {
    return null
  }

  // Two answers, never three. The agent's "don't ask again" is dropped rather
  // than rendered — it is the one choice that would silently remove the only
  // protection the parent selected.
  const yes = approval.options.at(0)
  const no = approval.options.at(-1)

  return (
    <div
      className="flex flex-col gap-4 rounded-lg border p-5"
      role="alertdialog"
      aria-label={translate('storyWorld.approval.label', 'Claude is asking you something')}
      data-testid="story-world-approval"
    >
      <p className="text-lg">{safeTitle(approval.title)}</p>
      <div className="flex gap-3">
        {yes ? (
          <button
            type="button"
            className="h-12 rounded-lg border px-6 text-base"
            onClick={() => onRespond(yes.send)}
          >
            {translate('storyWorld.approval.yes', 'Yes')}
          </button>
        ) : null}
        {no && no !== yes ? (
          <button
            type="button"
            className="h-12 rounded-lg border px-6 text-base"
            onClick={() => onRespond(no.send)}
          >
            {translate('storyWorld.approval.no', 'No')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
