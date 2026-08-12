import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { shouldResetActiveIdentityAfterClose } from './mobile-tab-close-active-reset'

describe('shouldResetActiveIdentityAfterClose', () => {
  it('resets when the closed tab was the active one', () => {
    expect(shouldResetActiveIdentityAfterClose('a', 'a', 2)).toBe(true)
  })

  it('resets when closing leaves no tabs, even if the closed tab was not active', () => {
    expect(shouldResetActiveIdentityAfterClose('b', 'a', 0)).toBe(true)
  })

  it('keeps active identity when a non-active tab closes and others remain', () => {
    expect(shouldResetActiveIdentityAfterClose('b', 'a', 3)).toBe(false)
  })

  it('resets a null active identity only when nothing remains', () => {
    expect(shouldResetActiveIdentityAfterClose(null, 'a', 1)).toBe(false)
    expect(shouldResetActiveIdentityAfterClose(null, 'a', 0)).toBe(true)
  })
})

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('mobile session last-tab close wiring', () => {
  it('drives the reset decision through the shared predicate', () => {
    const start = sessionRouteSource.indexOf('async function handleCloseSessionTab')
    const end = sessionRouteSource.indexOf('const bulkCloseActions', start)
    const block = sessionRouteSource.slice(start, end)

    // The final-tab reset must run through the extracted predicate, not a
    // hand-inlined `=== tab.id` check that misses the bulk-close last-tab case.
    expect(block).toContain(
      'shouldResetActiveIdentityAfterClose(activeSessionTabIdRef.current, tab.id, remainingTabs.length)'
    )
    expect(block).toContain('activeSessionTabIdRef.current = null')
    expect(block).toContain('activeHandleRef.current = null')
  })
})
