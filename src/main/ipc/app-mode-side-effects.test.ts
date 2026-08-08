/**
 * §2.5: a mode never overrides a settings value.
 *
 * The App Icon is the case that actually broke it. Applying manifest.appIcon
 * unconditionally silently replaced a user's chosen icon on EVERY mode switch,
 * and on packaged macOS also cleared the installed bundle's icon metadata on
 * disk — so Classic -> mode -> Classic was not lossless.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const applied: unknown[] = []

vi.mock('../app-icon', () => ({
  applyAppIcon: (value: unknown) => {
    applied.push(value)
  }
}))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({ recordCrashBreadcrumb: vi.fn() }))

describe('applyAppModeChange and the user App Icon', () => {
  beforeEach(() => {
    applied.length = 0
  })

  it('keeps the user icon when the mode declares no distinct one', async () => {
    const { applyAppModeChange } = await import('./app-mode-side-effects')
    applyAppModeChange('classic', 'alab', 'blue')
    // NOT the manifest default: every manifest currently carries 'classic', so
    // applying it would have wiped the user's choice on an unrelated action.
    expect(applied).toEqual(['blue'])
  })

  it('restores the same user icon on the way back, so the round trip is lossless', async () => {
    const { applyAppModeChange } = await import('./app-mode-side-effects')
    applyAppModeChange('classic', 'alab', 'blue')
    applyAppModeChange('alab', 'classic', 'blue')
    expect(applied).toEqual(['blue', 'blue'])
  })

  it('normalizes an unrecognized stored icon rather than passing it through', async () => {
    const { applyAppModeChange } = await import('./app-mode-side-effects')
    applyAppModeChange('classic', 'alab', 'not-a-real-icon')
    expect(applied).toEqual(['classic'])
  })

  it('does nothing at all when the mode did not change', async () => {
    const { applyAppModeChange } = await import('./app-mode-side-effects')
    applyAppModeChange('alab', 'alab', 'blue')
    expect(applied).toEqual([])
  })
})
