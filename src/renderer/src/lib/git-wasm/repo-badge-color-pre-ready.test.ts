// Deliberately does NOT import './init-git-wasm-for-test' at the top: this file
// exists to observe the shim BEFORE the core is ready. This is the module whose
// pre-ready value reverted the cut-over — the shim returned the default gray and
// ColorPicker persisted it over the user's saved repo colour — so both wrong
// candidates (`null` and DEFAULT_REPO_BADGE_COLOR) are pinned out here by name.
import { describe, expect, it } from 'vitest'
import { getGitWasmAvailability } from './git-wasm-availability'
import { normalizeRepoBadgeColor, resolveRepoBadgeColor } from './repo-badge-color'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'

describe('repo-badge-color pre-ready value', () => {
  it('returns the undefined sentinel — never the default colour — while the core is pending', () => {
    expect(getGitWasmAvailability()).toBe('pending')

    // The reverted value. DEFAULT_REPO_BADGE_COLOR is the twin's answer only for
    // an INVALID input, so returning it for '#ff0000' is a fabricated answer that
    // ColorPicker.updateColor would write back to the repo.
    expect(resolveRepoBadgeColor('#ff0000')).toBeUndefined()
    expect(resolveRepoBadgeColor('#ff0000')).not.toBe(DEFAULT_REPO_BADGE_COLOR)
    expect(resolveRepoBadgeColor('nope')).toBeUndefined()

    // ...and `null` is not available as the sentinel either: the ready core
    // returns null for a genuinely invalid colour, which ColorPicker reads as
    // "show Invalid hex color".
    expect(normalizeRepoBadgeColor('#ff0000')).toBeUndefined()
    expect(normalizeRepoBadgeColor('#ff0000')).not.toBeNull()
    expect(normalizeRepoBadgeColor('not-a-colour')).toBeUndefined()
    expect(normalizeRepoBadgeColor(undefined)).toBeUndefined()
  })

  it('answers from the input once the core lands, proving no constant could have stood in', async () => {
    await import('./init-git-wasm-for-test')
    expect(getGitWasmAvailability()).toBe('ready')

    // The ready answers depend on the input — the definition of contract case 3.
    expect(resolveRepoBadgeColor('#ff0000')).toBe('#ff0000')
    expect(resolveRepoBadgeColor('nope')).toBe(DEFAULT_REPO_BADGE_COLOR)
    expect(normalizeRepoBadgeColor('#ff0000')).toBe('#ff0000')
    expect(normalizeRepoBadgeColor('not-a-colour')).toBeNull()

    // Non-strings never reached the Rust core in the twin either (`typeof value
    // !== 'string'` returned null); the shim coerces them so the codec's
    // undefined-property rejection cannot fire on a plain `repo.badgeColor`.
    expect(normalizeRepoBadgeColor(undefined)).toBeNull()
    expect(normalizeRepoBadgeColor(null)).toBeNull()
    expect(normalizeRepoBadgeColor(123)).toBeNull()
    expect(resolveRepoBadgeColor(undefined)).toBe(DEFAULT_REPO_BADGE_COLOR)

    // Parity spot-checks against the deleted TS regex: trim, case-fold, expand.
    expect(normalizeRepoBadgeColor('  ABCDEF ')).toBe('#abcdef')
    expect(normalizeRepoBadgeColor('#abc')).toBe('#aabbcc')
    expect(normalizeRepoBadgeColor('url(javascript:alert(1))')).toBeNull()
  })
})
