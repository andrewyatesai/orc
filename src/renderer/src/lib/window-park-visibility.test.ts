// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility,
  WINDOW_HIDE_PARK_GRACE_MS
} from './window-park-visibility'

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('window-park-visibility', () => {
  beforeEach(() => {
    setDocumentVisibility('visible')
  })

  afterEach(() => {
    setDocumentVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
    vi.restoreAllMocks()
  })

  it('shares one grace window across every park site', () => {
    expect(WINDOW_HIDE_PARK_GRACE_MS).toBe(500)
  })

  it('reports visible when the window is visible and not-visible when trusted-hidden', () => {
    setDocumentVisibility('visible')
    expect(getWindowParkVisible()).toBe(true)
    setDocumentVisibility('hidden')
    expect(getWindowParkVisible()).toBe(false)
  })

  // Pins the `|| isDocumentVisibilityProvenStale()` term: dropping it wedges every park site
  // hidden forever whenever macOS stops reporting occlusion changes.
  it('keeps a wedged-hidden window visible once user input disproves the occlusion state', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setDocumentVisibility('hidden')
    const unsubscribe = subscribeWindowParkVisibility(() => {})
    expect(getWindowParkVisible()).toBe(false)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(document.visibilityState).toBe('hidden')
    expect(getWindowParkVisible()).toBe(true)
    unsubscribe()
  })

  it('invokes onChange on a genuine visibilitychange and stops after teardown', () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeWindowParkVisibility(onChange)

    document.dispatchEvent(new Event('visibilitychange'))
    expect(onChange).toHaveBeenCalledTimes(1)

    unsubscribe()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  // The stale latch flips to proven-visible without emitting a visibilitychange, so the
  // subscription must also register stale recovery to notice it.
  it('invokes onChange when the stale latch is proven without a visibilitychange, and detaches on teardown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setDocumentVisibility('hidden')
    const onChange = vi.fn()
    const unsubscribe = subscribeWindowParkVisibility(onChange)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(onChange).toHaveBeenCalled()

    unsubscribe()
    const callsAfterTeardown = onChange.mock.calls.length
    setDocumentVisibility('visible')
    setDocumentVisibility('hidden')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }))
    expect(onChange).toHaveBeenCalledTimes(callsAfterTeardown)
  })

  // Load-bearing ordering: stale recovery is registered before the visibilitychange listener, so
  // the stale module's own handler clears the latch before onChange reads it. Swap the order back
  // and onChange observes a stale `true` on the resume tick.
  it('clears the stale latch before onChange observes it on a genuine visibilitychange', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setDocumentVisibility('hidden')
    const observed: boolean[] = []
    const unsubscribe = subscribeWindowParkVisibility(() => {
      observed.push(getWindowParkVisible())
    })

    // Prove the occlusion tracker stale — recovery fires without a visibilitychange.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(observed.at(-1)).toBe(true)

    // A genuine visibilitychange hands authority back to the tracker; onChange must see it cleared.
    document.dispatchEvent(new Event('visibilitychange'))
    expect(observed.at(-1)).toBe(false)
    unsubscribe()
  })
})
