// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import { WINDOW_STREAM_PARK_DELAY_MS } from '@/hooks/use-window-stream-visibility'
import { useRemoteBrowserStreamActive } from './use-remote-browser-stream-activation'

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useRemoteBrowserStreamActive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setDocumentVisibility('visible')
  })

  afterEach(() => {
    cleanup()
    setDocumentVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is inactive whenever the pane is a background tab, even on a visible window', () => {
    const hook = renderHook(() => useRemoteBrowserStreamActive(false))
    expect(hook.result.current).toBe(false)
  })

  it('is active for a visible pane on a visible window', () => {
    const hook = renderHook(() => useRemoteBrowserStreamActive(true))
    expect(hook.result.current).toBe(true)
  })

  it('parks the screencast after the window stays hidden past the grace period', async () => {
    const hook = renderHook(() => useRemoteBrowserStreamActive(true))
    expect(hook.result.current).toBe(true)

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS - 1))
    expect(hook.result.current).toBe(true)

    await act(async () => vi.advanceTimersByTime(1))
    expect(hook.result.current).toBe(false)

    await act(async () => setDocumentVisibility('visible'))
    expect(hook.result.current).toBe(true)
  })

  // Pins the stale-visibility term: a wedged-hidden document must not park a screencast the user
  // is looking at once real input disproves the occlusion state.
  it('keeps the screencast active while hidden once user input proves visibility is stale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hook = renderHook(() => useRemoteBrowserStreamActive(true))

    await act(async () => setDocumentVisibility('hidden'))
    await act(async () => vi.advanceTimersByTime(WINDOW_STREAM_PARK_DELAY_MS))
    expect(hook.result.current).toBe(false)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(document.visibilityState).toBe('hidden')
    expect(hook.result.current).toBe(true)
  })
})
