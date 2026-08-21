/**
 * Port of d4f2ae145 (#12301) — the ja source-control primary-action buttons
 * "Push"/"Pull" shipped as the physical-motion verbs 押す (press) / 引く (pull an
 * object) instead of the git katakana プッシュ / プル. Guards the fix so bootstrap
 * re-translation cannot silently regress it, anchored on the en source string so
 * the assertion tracks the git button — not some other reuse of the same word.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import ja from './locales/ja.json'

function findByKey(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByKey(item, key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  const record = node as Record<string, unknown>
  if (typeof record[key] === 'string') {
    return record[key] as string
  }
  for (const value of Object.values(record)) {
    const found = findByKey(value, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

const PUSH_KEY = '95550cff15'
const PULL_KEY = 'd64292a938'

describe('ja source-control Push/Pull button translations (#12301)', () => {
  it('anchors on the en git-button source strings', () => {
    expect(findByKey(en, PUSH_KEY)).toBe('Push')
    expect(findByKey(en, PULL_KEY)).toBe('Pull')
  })

  it('translates git Push/Pull as katakana, not the physical-motion verbs', () => {
    expect(findByKey(ja, PUSH_KEY)).toBe('プッシュ')
    expect(findByKey(ja, PULL_KEY)).toBe('プル')
  })

  it('does not regress to 押す (press) / 引く (pull object)', () => {
    expect(findByKey(ja, PUSH_KEY)).not.toBe('押す')
    expect(findByKey(ja, PULL_KEY)).not.toBe('引く')
  })
})
