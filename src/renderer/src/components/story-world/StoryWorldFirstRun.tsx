/**
 * The parent's three screens — `docs/reference/app-modes.md` §7.6.
 *
 * Parent-facing, so the §7.8 child copy rules do NOT apply here: an adult
 * performing an adult task needs the real words, including the uncomfortable
 * ones. Softening these screens would be the actual harm.
 *
 * **Screen three blocks, has no skip, and has no default.** `DEFAULT_TUI_AGENT_ARGS`
 * is `YOLO_TUI_AGENT_ARGS`, so an untouched install launches with permission
 * prompts bypassed. Story World will not open a world until a parent has chosen,
 * because inheriting that silently is the one outcome nobody would consent to.
 *
 * Two things are stated plainly rather than implied:
 *  - Selecting a folder marks it trusted for the chosen agent by writing OUTSIDE
 *    Orca, and Orca has no revoke path — no untrust function exists anywhere.
 *  - The agent runs with the parent's full filesystem and network access EITHER
 *    WAY. Ask-me-first is a prompt, not a sandbox. §7.8 rule 7 forbids asserting
 *    a boundary the runtime cannot enforce, and this is that boundary.
 */

import { useState } from 'react'
import { translate } from '@/i18n/i18n'

export type StoryPermissionChoice = 'ask-me-first' | 'let-it-work'

export type StoryWorldFirstRunProps = {
  onComplete: (choice: StoryPermissionChoice) => void
}

export function StoryWorldFirstRun({ onComplete }: StoryWorldFirstRunProps): React.JSX.Element {
  const [screen, setScreen] = useState<1 | 2 | 3>(1)
  // No initial value: there is deliberately no default to fall through to.
  const [choice, setChoice] = useState<StoryPermissionChoice | null>(null)

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6" data-testid="story-world-first-run">
      {screen === 1 ? (
        <>
          <h1 className="text-lg font-semibold">{translate('storyWorld.firstRun.folderTitle', 'Pick a folder for your child\'s worlds')}</h1>
          <p className="text-sm">
            {translate(
              'storyWorld.firstRun.folderBody',
              'A plain folder works; it does not need to be a git repository.'
            )}
          </p>
          <p className="text-muted-foreground text-sm">
            {translate(
              'storyWorld.firstRun.folderTrust',
              "Choosing a folder marks it trusted for the agent you pick next. That trust is written outside Orca, in the agent's own configuration, and Orca cannot undo it — there is no revoke path in the app."
            )}
          </p>
          <button type="button" className="h-12 self-start rounded-lg border px-5" onClick={() => setScreen(2)}>
            {translate('storyWorld.firstRun.continue', 'Continue')}
          </button>
        </>
      ) : null}

      {screen === 2 ? (
        <>
          <h1 className="text-lg font-semibold">{translate('storyWorld.firstRun.agentTitle', 'Pick an agent')}</h1>
          <p className="text-muted-foreground text-sm">
            {translate(
              'storyWorld.firstRun.agentBody',
              'Only some agents can be confined by the operating system. Orca will not offer one it cannot verify, and it will not pretend an unconfinable agent is contained.'
            )}
          </p>
          <button type="button" className="h-12 self-start rounded-lg border px-5" onClick={() => setScreen(3)}>
            {translate('storyWorld.firstRun.continue', 'Continue')}
          </button>
        </>
      ) : null}

      {screen === 3 ? (
        <>
          <h1 className="text-lg font-semibold">{translate('storyWorld.firstRun.permTitle', 'How should the agent ask permission?')}</h1>
          <p className="text-muted-foreground text-sm">
            {/* One string, not split around markup: §7.8 rule 7 forbids asserting
                a boundary the runtime cannot enforce, and a half-translated
                sentence is exactly how that claim gets softened in another
                locale. */}
            {translate(
              'storyWorld.firstRun.permBody',
              'The agent runs with your full filesystem and network access either way. Ask-me-first is a prompt, not a sandbox.'
            )}
          </p>
          <fieldset className="flex flex-col gap-2">
            <label className="flex items-start gap-3 rounded-lg border p-3">
              <input
                type="radio"
                name="story-permission"
                checked={choice === 'ask-me-first'}
                onChange={() => setChoice('ask-me-first')}
              />
              <span className="flex flex-col">
                <span className="font-medium">{translate('storyWorld.firstRun.ask', 'Ask me first')}</span>
                <span className="text-muted-foreground text-sm">
                  {translate(
                    'storyWorld.firstRun.askBody',
                    'Your child sees a two-button question before the agent changes anything.'
                  )}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-lg border p-3">
              <input
                type="radio"
                name="story-permission"
                checked={choice === 'let-it-work'}
                onChange={() => setChoice('let-it-work')}
              />
              <span className="flex flex-col">
                <span className="font-medium">{translate('storyWorld.firstRun.yolo', 'Let it work')}</span>
                <span className="text-muted-foreground text-sm">
                  {translate(
                    'storyWorld.firstRun.yoloBody',
                    'No prompts. The agent changes files without asking.'
                  )}
                </span>
              </span>
            </label>
          </fieldset>
          {/* No skip. Disabled until a real choice exists — there is no default
              to inherit, because the install default is prompts-bypassed. */}
          <button
            type="button"
            className="h-12 self-start rounded-lg border px-5 disabled:opacity-50"
            disabled={choice === null}
            onClick={() => choice && onComplete(choice)}
          >
            {translate('storyWorld.firstRun.open', 'Open the world')}
          </button>
        </>
      ) : null}
    </div>
  )
}
