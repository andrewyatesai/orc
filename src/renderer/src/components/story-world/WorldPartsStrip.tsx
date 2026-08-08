/**
 * The child's vocabulary, as tiles — `docs/reference/app-modes.md` §7.4.
 *
 * Seeded starters exist to break a circular dependency that would otherwise make
 * the mode unusable on first run: the parts palette is populated by an agent,
 * and the only way to reach the agent is through the palette. A brand-new world
 * is therefore never an empty strip.
 *
 * Every tile is an icon AND a word (§7.8 rule 2) — a child who cannot read needs
 * the picture, and a child who can needs the word to learn it. Emoji appear only
 * as content the child chose; these seeded tiles use shapes, not emoji, because
 * they are Orca's words rather than hers.
 */

import { translate } from '@/i18n/i18n'
import { isButtonLabelShortEnough } from './story-world-copy'

/** §7.4's SEEDED_STARTER_PARTS. Each is a whole sentence the child can send. */
export const SEEDED_STARTER_PARTS: readonly {
  id: string
  labelKey: string
  label: string
  sentenceKey: string
  sentence: string
}[] = [
  {
    id: 'make',
    labelKey: 'storyWorld.parts.make',
    label: 'Make something',
    sentenceKey: 'storyWorld.parts.makeSentence',
    sentence: 'Make something for me to play with.'
  },
  {
    id: 'add',
    labelKey: 'storyWorld.parts.add',
    label: 'Add one',
    sentenceKey: 'storyWorld.parts.addSentence',
    sentence: 'Add one more thing to my world.'
  },
  {
    id: 'bigger',
    labelKey: 'storyWorld.parts.bigger',
    label: 'Make it bigger',
    sentenceKey: 'storyWorld.parts.biggerSentence',
    sentence: 'Make it bigger.'
  },
  {
    id: 'move',
    labelKey: 'storyWorld.parts.move',
    label: 'Make it move',
    sentenceKey: 'storyWorld.parts.moveSentence',
    sentence: 'Make it move.'
  },
  {
    id: 'colour',
    labelKey: 'storyWorld.parts.colour',
    label: 'Change the color',
    sentenceKey: 'storyWorld.parts.colourSentence',
    sentence: 'Change the color.'
  }
]

export type WorldPartsStripProps = {
  /** Composes the sentence into the draft rather than sending it: §7.2's
   *  composer is always mounted and the child watches her words appear. */
  onCompose?: (sentence: string) => void
}

export function WorldPartsStrip({ onCompose }: WorldPartsStripProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2" data-testid="story-world-parts">
      {SEEDED_STARTER_PARTS.map((part) => (
        <button
          key={part.id}
          type="button"
          // 48px minimum: the `touch` size tier exists for exactly this, and
          // per-component overrides were rejected in favour of the CVA variant.
          className="flex h-12 min-w-[6rem] items-center gap-2 rounded-lg border px-4 text-base"
          onClick={() => onCompose?.(translate(part.sentenceKey, part.sentence))}
        >
          <span aria-hidden="true" className="size-3 rounded-full bg-foreground/70" />
          <span>{translate(part.labelKey, part.label)}</span>
        </button>
      ))}
    </div>
  )
}

/** Exported for the copy test: every seeded label must obey the five-word rule. */
export function seededLabelsObeyCopyRules(): boolean {
  return SEEDED_STARTER_PARTS.every((part) => isButtonLabelShortEnough(part.label))
}
