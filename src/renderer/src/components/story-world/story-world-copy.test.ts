/**
 * §7.8's copy rules, enforced rather than described.
 *
 * These strings are data, so no lint rule can catch a path or the word "error"
 * reaching a six-year-old. This suite is the guard.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BANNED_CHILD_FACING_WORDS,
  STORY_STATUS_WORDS,
  isButtonLabelShortEnough,
  isChildSafeCopy,
  storyStatusWord,
  type StoryAgentState
} from './story-world-copy'
import { SEEDED_STARTER_PARTS, seededLabelsObeyCopyRules } from './WorldPartsStrip'
import { STORY_COMPOSER_SEND_LABEL, composerLabelObeysCopyRules } from './StoryComposer'
import { resolveModeManifest } from '../../../../shared/app-mode/app-mode-capability'

/** Every AgentDotState member (§7.8 rule 4 names all eight). */
const ALL_AGENT_STATES: StoryAgentState[] = [
  'working',
  'blocked',
  'waiting',
  'interrupted',
  'failed',
  'done',
  'idle',
  'permission'
]

describe('the five status words', () => {
  it('covers all eight agent states — an unmapped one would leak raw vocabulary', () => {
    for (const state of ALL_AGENT_STATES) {
      expect(STORY_STATUS_WORDS[state]).toBeDefined()
    }
    expect(Object.keys(STORY_STATUS_WORDS).sort()).toEqual([...ALL_AGENT_STATES].sort())
  })

  it('uses exactly five distinct words, not eight', () => {
    expect(new Set(Object.values(STORY_STATUS_WORDS)).size).toBe(5)
  })

  it('treats no-status-yet as Ready — a new world is not a fault', () => {
    expect(storyStatusWord(null)).toBe('Ready')
    expect(storyStatusWord(undefined)).toBe('Ready')
  })

  it('never surfaces a banned word as a status', () => {
    for (const word of Object.values(STORY_STATUS_WORDS)) {
      expect(isChildSafeCopy(word)).toBe(true)
    }
  })

  it('collapses failed and interrupted to one idea — she cannot act on the difference', () => {
    expect(STORY_STATUS_WORDS.failed).toBe(STORY_STATUS_WORDS.interrupted)
  })
})

describe('isChildSafeCopy', () => {
  it.each(BANNED_CHILD_FACING_WORDS)('rejects %s', (word) => {
    expect(isChildSafeCopy(`Something ${word} happened`)).toBe(false)
  })

  it.each([
    ['a filesystem path', 'Look in /Users/kid/game.js'],
    ['a home path', 'saved to ~/worlds/kitty'],
    ['a git hash', 'commit a1b2c3d4e5f'],
    ['a port', 'open localhost:5173']
  ])('rejects %s', (_label, text) => {
    expect(isChildSafeCopy(text)).toBe(false)
  })

  it('accepts the copy this mode actually uses', () => {
    expect(isChildSafeCopy('Your game got stuck.')).toBe(true)
    expect(isChildSafeCopy('Make a new world')).toBe(true)
  })
})

describe('button labels', () => {
  it('every seeded part obeys the five-word rule', () => {
    expect(seededLabelsObeyCopyRules()).toBe(true)
  })

  it('every seeded part is child-safe and sends a whole sentence', () => {
    for (const part of SEEDED_STARTER_PARTS) {
      expect(isChildSafeCopy(part.label)).toBe(true)
      expect(isChildSafeCopy(part.sentence)).toBe(true)
      // A sentence, not a fragment: the child watches her words appear.
      expect(part.sentence.trim().endsWith('.')).toBe(true)
    }
  })

  it('the composer send label obeys the rules', () => {
    expect(composerLabelObeysCopyRules()).toBe(true)
    expect(isChildSafeCopy(STORY_COMPOSER_SEND_LABEL)).toBe(true)
  })

  it('rejects a six-word label', () => {
    expect(isButtonLabelShortEnough('one two three four five six')).toBe(false)
  })

  it('seeds a non-empty palette, or the mode is unreachable on first run', () => {
    // The palette is populated by an agent, and the only way to reach the agent
    // is through the palette. Without seeds a brand-new world is a dead end.
    expect(SEEDED_STARTER_PARTS.length).toBeGreaterThan(0)
  })
})

describe('the child-facing components themselves', () => {
  // WorldPartsStrip is deliberately absent: its labels are not inline fallbacks
  // but the exported SEEDED_STARTER_PARTS data, which the suite above sweeps
  // directly. Listing it here would assert on strings that do not exist.
  const files = ['StoryStage.tsx', 'MyWorldsList.tsx', 'StoryComposer.tsx', 'StoryStripHeader.tsx']

  it.each(files)('%s contains no banned word in a user-visible string', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8')
    // Only the English fallbacks in translate(key, 'fallback') are user-visible;
    // comments legitimately discuss errors and paths.
    const fallbacks = [...source.matchAll(/translate\(\s*[^,]+,\s*'([^']+)'/g)].map((m) => m[1])
    expect(fallbacks.length).toBeGreaterThan(0)
    for (const fallback of fallbacks) {
      expect({ file, fallback, safe: isChildSafeCopy(fallback) }).toEqual({
        file,
        fallback,
        safe: true
      })
    }
  })
})

describe('the crash path (§7.8 reaches it too)', () => {
  it('the child-facing crash copy is itself child-safe', () => {
    // The generic boundary says "This part of Orca hit an error." — the one
    // child-facing surface the copy rules did not originally reach.
    for (const text of [
      'Your game got stuck.',
      'Nothing is broken. Try again, or show a grown-up.'
    ]) {
      expect(isChildSafeCopy(text)).toBe(true)
    }
  })

  it('the generic boundary copy would NOT be child-safe, which is why it is overridden', () => {
    expect(isChildSafeCopy('This part of Orca hit an error.')).toBe(false)
  })

  it('only the child-facing mode gets child copy', () => {
    // Keyed off an explicit manifest field. Inferring it from a style variable
    // would have handed child copy to any future mode that set a font scale.
    // Through the sanctioned reader, not a raw registry index — the containment
    // rule applies to tests too, and it caught this exact line.
    expect(resolveModeManifest('story-world').childFacing).toBe(true)
    expect(resolveModeManifest('alab').childFacing).toBe(false)
    expect(resolveModeManifest('classic').childFacing).toBe(false)
  })
})

describe('paths and git terms the first predicate missed', () => {
  it.each([
    ['a parenthesised POSIX path', 'open ("/Users/kid/game.js")'],
    ['a Windows path', 'C:\\Users\\kid\\game.js'],
    ['a relative source path', 'check src/game.js'],
    ['a bare filename', 'game.js is broken'],
    ['a git term', 'I will commit that for you'],
    ['a URL', 'see https://example.com']
  ])('rejects %s', (_label, text) => {
    expect(isChildSafeCopy(text)).toBe(false)
  })
})
