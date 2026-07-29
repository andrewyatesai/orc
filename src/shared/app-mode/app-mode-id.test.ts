import { describe, expect, it } from 'vitest'
import {
  APP_MODE_OPTIONS,
  DEFAULT_APP_MODE_ID,
  normalizeAppModeId,
  parseAppModeId
} from './app-mode-id'

describe('app mode id', () => {
  it('defaults to classic so a broken config never lands a user in another shell', () => {
    expect(DEFAULT_APP_MODE_ID).toBe('classic')
  })

  it('ships exactly the three modes', () => {
    expect(APP_MODE_OPTIONS.map((option) => option.id)).toEqual(['classic', 'alab', 'story-world'])
  })

  it.each([['classic'], ['alab'], ['story-world']])('parses %s', (id) => {
    expect(parseAppModeId(id)).toBe(id)
  })

  it.each([['storyworld'], ['story world'], ['StoryWorld'], ['ALab'], ['Classic'], ['kids'], ['']])(
    'returns null for the unrecognized string %j so the rung falls through',
    (value) => {
      expect(parseAppModeId(value)).toBeNull()
    }
  )

  it.each([[undefined], [null], [42], [{ appMode: 'alab' }], [['alab']], [true]])(
    'returns null for the non-string %j',
    (value) => {
      expect(parseAppModeId(value)).toBeNull()
    }
  )

  it('does not accept inherited Object.prototype keys', () => {
    // Why: a hand-edited or agent-written sidecar is untrusted input; `in` would let these through.
    expect(parseAppModeId('__proto__')).toBeNull()
    expect(parseAppModeId('constructor')).toBeNull()
    expect(parseAppModeId('toString')).toBeNull()
    expect(parseAppModeId('hasOwnProperty')).toBeNull()
  })

  it('normalizes unusable input to the default, but only as a terminal fallback', () => {
    expect(normalizeAppModeId('alab')).toBe('alab')
    expect(normalizeAppModeId('kids')).toBe('classic')
    expect(normalizeAppModeId(undefined)).toBe('classic')
  })
})
