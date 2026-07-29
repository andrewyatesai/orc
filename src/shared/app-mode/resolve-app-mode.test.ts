import { describe, expect, it } from 'vitest'
import { isAppModeSelectionLocked, resolveAppMode } from './resolve-app-mode'

describe('resolveAppMode', () => {
  it('falls back to built-in classic with nothing configured', () => {
    expect(resolveAppMode({})).toEqual({ mode: 'classic', source: 'built-in' })
  })

  it('uses the unlocked sidecar — the rung the menu, Settings and the file all write', () => {
    expect(resolveAppMode({ pinned: { appMode: 'alab' } })).toEqual({
      mode: 'alab',
      source: 'default'
    })
  })

  it('lets env win over everything', () => {
    expect(
      resolveAppMode({
        envMode: 'classic',
        pinned: { appMode: 'story-world', lock: true },
        repoOverride: 'alab'
      })
    ).toEqual({ mode: 'classic', source: 'env' })
  })

  it('hoists a locked sidecar above the per-project override', () => {
    expect(
      resolveAppMode({ pinned: { appMode: 'story-world', lock: true }, repoOverride: 'alab' })
    ).toEqual({ mode: 'story-world', source: 'lock' })
  })

  it('lets a per-project override beat an UNLOCKED sidecar', () => {
    expect(resolveAppMode({ pinned: { appMode: 'classic' }, repoOverride: 'alab' })).toEqual({
      mode: 'alab',
      source: 'project'
    })
  })

  it('ignores lock:true when the pinned mode itself is unparseable', () => {
    // Why: lock must not be able to pin a value that does not exist.
    expect(
      resolveAppMode({ pinned: { appMode: 'kids', lock: true }, repoOverride: 'alab' })
    ).toEqual({ mode: 'alab', source: 'project' })
  })

  it.each([['kids'], [''], [null], [undefined], [7]])(
    'falls THROUGH an unparseable high-precedence rung (%j) instead of coercing it to classic',
    (envMode) => {
      // This is the whole reason parse and normalize are separate: coercing here would let a typo
      // in the env var silently override the user's real, valid sidecar choice.
      expect(resolveAppMode({ envMode, pinned: { appMode: 'alab' } })).toEqual({
        mode: 'alab',
        source: 'default'
      })
    }
  )

  it('treats a truthy-but-not-true lock as unlocked', () => {
    expect(
      resolveAppMode({ pinned: { appMode: 'story-world', lock: 'yes' }, repoOverride: 'alab' })
    ).toEqual({ mode: 'alab', source: 'project' })
  })

  it('forces classic for paired web clients, which have no menu bar to switch with', () => {
    expect(
      resolveAppMode({
        isWebClient: true,
        envMode: 'alab',
        pinned: { appMode: 'alab', lock: true }
      })
    ).toEqual({ mode: 'classic', source: 'built-in' })
  })

  it('marks only env and lock as locking the UI selectors', () => {
    expect(isAppModeSelectionLocked('env')).toBe(true)
    expect(isAppModeSelectionLocked('lock')).toBe(true)
    expect(isAppModeSelectionLocked('project')).toBe(false)
    expect(isAppModeSelectionLocked('default')).toBe(false)
    expect(isAppModeSelectionLocked('built-in')).toBe(false)
  })
})
