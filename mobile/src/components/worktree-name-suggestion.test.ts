import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from '../../../src/shared/marine-creatures'
import { getSuggestedCreatureName } from './worktree-name-suggestion'

// Why: the mobile mirror of the corpus was deleted; this seam proves the
// production consumer resolves the shared src/shared/marine-creatures module
// (Metro watches it via metro.config.js) and draws its pool from there. A
// broken relative import would fail to load this module before any assertion.
const normalized = MARINE_CREATURES.map((name) => name.trim().toLowerCase())

describe('worktree name suggestion seam', () => {
  it('draws its whole pool from the shared marine-creature corpus', () => {
    const produced = new Set<string>()
    for (let i = 0; i < MARINE_CREATURES.length; i += 1) {
      produced.add(getSuggestedCreatureName([], () => (i + 0.5) / MARINE_CREATURES.length))
    }

    expect([...produced].sort()).toEqual([...new Set(normalized)].sort())
  })

  it('numbers a shared-corpus name once every base name is taken', () => {
    const suggestion = getSuggestedCreatureName(normalized, () => 0)

    expect(suggestion).toBe(`${normalized[0]}-2`)
  })
})
