/**
 * Story World's `workspace-body` capsule — `docs/reference/app-modes.md` §7.1.
 *
 * The centre band of a three-band stage. Everything a child sees goes through
 * `story-world-copy.ts`, which is enforced by a test that sweeps this file's
 * strings — a path, a hash, or the word "error" reaching this surface is a bug,
 * not a style problem.
 *
 * **What this build honestly is.** The stage frames the agent and the child's
 * own words. It does NOT yet contain the live game window (§7.3's loopback play
 * server) or the approval overlay (§7.6), and it says so in language a parent
 * can act on rather than pretending the mode is finished. §4's rule holds:
 * entering a mode never launches an agent and never spends money — this
 * component starts nothing on mount.
 *
 * The terminal is deliberately NOT re-parented here. `<Terminal/>` is a sibling
 * in the main pane column and stays mounted in every mode (§5.1); relocating a
 * live pane is the pane-portal's job, and doing it by re-mounting would destroy
 * the aterm instance and the child's whole session with it.
 */

import { translate } from '@/i18n/i18n'
import { storyStatusWord, type StoryAgentState } from './story-world-copy'
import { WorldPartsStrip } from './WorldPartsStrip'

export type StoryStageProps = {
  /** Null while nothing has reported yet — which is a new world, not a fault. */
  agentState?: StoryAgentState | null
}

export default function StoryStage({ agentState = null }: StoryStageProps): React.JSX.Element {
  const status = storyStatusWord(agentState)

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 p-6"
      data-testid="story-world-stage"
      style={{ fontSize: 'calc(1rem * var(--app-font-scale, 1))' }}
    >
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">
          {translate('storyWorld.stage.talkTo', 'Talk to Claude')}
        </h1>
        {/* The status word is paired with a shape, never colour alone (§10.8):
            a child who cannot read still needs to tell these apart. */}
        <span
          className="rounded-full border px-3 py-1 text-sm"
          role="status"
          aria-label={translate('storyWorld.stage.statusLabel', 'What is happening')}
        >
          {translate(`storyWorld.status.${status}`, status)}
        </span>
      </header>

      <p className="text-muted-foreground text-sm">
        {translate(
          'storyWorld.stage.hint',
          'Tell Claude what you want. It will build it for you.'
        )}
      </p>

      <div className="min-h-0 flex-1 rounded-lg border p-4">
        <p className="text-muted-foreground text-sm">
          {/* Honest about the unfinished half, in words a parent can act on and a
              child is not frightened by. No paths, no versions, no "not
              implemented". */}
          {translate(
            'storyWorld.stage.windowComing',
            'The window that shows your game is not ready yet. Your words still reach Claude.'
          )}
        </p>
      </div>

      <WorldPartsStrip />
    </div>
  )
}
