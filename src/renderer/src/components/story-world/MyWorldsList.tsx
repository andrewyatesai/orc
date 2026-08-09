/**
 * Story World's `left-sidebar-body` capsule — `docs/reference/app-modes.md` §7.1.
 *
 * Picture-led cards, one per world, and ONE "make a new world" button.
 *
 * **No delete affordance**, deliberately. A six-year-old cannot evaluate an
 * irreversible action, and there is no undo she could operate. Deleting a world
 * lives behind the press-and-hold grown-up panel (§7.6) where an adult does it.
 */

import { translate } from '@/i18n/i18n'

export type StoryWorld = {
  id: string
  name: string
  /** "played 2 days ago" — recency in words, never a timestamp (§7.8 rule 3). */
  lastPlayedLabel: string
}

export type MyWorldsListProps = {
  worlds?: readonly StoryWorld[]
  onOpen?: (id: string) => void
  onCreate?: () => void
}

/** Stable reference: a fresh [] each render breaks referential equality. */
const NO_WORLDS: readonly StoryWorld[] = []

export default function MyWorldsList({
  worlds = NO_WORLDS,
  onOpen,
  onCreate
}: MyWorldsListProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="story-world-worlds">
      <h2 className="text-base font-semibold">
        {translate('storyWorld.worlds.heading', 'My worlds')}
      </h2>

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scrollbar-sleek">
        {worlds.map((world) => (
          <li key={world.id}>
            <button
              type="button"
              className="flex w-full flex-col items-start gap-1 rounded-lg border p-3 text-left"
              onClick={() => onOpen?.(world.id)}
            >
              <span className="text-base">{world.name}</span>
              <span className="text-muted-foreground text-sm">{world.lastPlayedLabel}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Icon and word, 48px tall, four words. */}
      <button
        type="button"
        className="flex h-12 items-center gap-2 rounded-lg border px-4 text-base"
        onClick={() => onCreate?.()}
      >
        <span aria-hidden="true" className="text-lg leading-none">
          +
        </span>
        <span>{translate('storyWorld.worlds.create', 'Make a new world')}</span>
      </button>
    </div>
  )
}
