// @vitest-environment happy-dom

// #12871: a cursor chord (Cmd+Left) pressed while a syllable is still composing must reach the pty
// AFTER the composed glyph commits. The glyph flushes from aterm's compositionend handler, which
// runs after this keydown; sending the chord now overtakes the text it was typed after — `가나`
// on the line, `가나다` then Cmd+Left, leaves `다가나`, the composing `다` at the cursor's
// destination. The fix defers any sendInput chord while a composition is live, without a deadline.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'
import { TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS } from './terminal-ime-deferred-chord'
import type { PtyTransport } from './pty-transport'

type Pane = {
  id: number
  leafId: string
  terminal: { getSelection: () => string; focus: () => void; element: HTMLElement }
  atermController: null
}

/** Live compositionend registrations on the terminal element, so a deferral that never disposes
 *  is visible. Installed after the harness's own listener so only the deferral's own is counted. */
function trackDeferralListeners(element: HTMLElement): () => number {
  const live = new Set<EventListenerOrEventListenerObject>()
  const { addEventListener, removeEventListener } = element
  element.addEventListener = function (type, listener, options): void {
    if (type === 'compositionend' && listener) {
      live.add(listener)
    }
    addEventListener.call(this, type, listener, options)
  }
  element.removeEventListener = function (type, listener, options): void {
    if (type === 'compositionend' && listener) {
      live.delete(listener)
    }
    removeEventListener.call(this, type, listener, options)
  }
  return () => live.size
}

function createHarness(): { pane: Pane; wire: string[]; deferralListenerCount: () => number } {
  // Every byte reaching the pty, in arrival order, whichever route it took.
  const wire: string[] = []
  const element = document.createElement('div')
  // aterm forwards the committed glyph synchronously from its own compositionend handler; model
  // that here so the assertion is about the merged order of the glyph and the chord.
  element.addEventListener('compositionend', () => wire.push('다'))
  // Installed after the harness's own listener so only the deferral's own registration is counted.
  const deferralListenerCount = trackDeferralListeners(element)
  const pane: Pane = {
    id: 1,
    leafId: 'leaf-1',
    terminal: { getSelection: () => '', focus: vi.fn(), element },
    atermController: null
  }
  return { pane, wire, deferralListenerCount }
}

function mountShortcuts(pane: Pane, wire: string[]) {
  const transports = new Map<number, PtyTransport>([
    [
      pane.id,
      {
        sendInput: (data: string) => {
          wire.push(data)
          return true
        }
      } as unknown as PtyTransport
    ]
  ])
  const noop = (): void => undefined
  return renderHook(() =>
    useTerminalKeyboardShortcuts({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      keyboardScopeRef: { current: null },
      managerRef: {
        current: {
          getActivePane: () => pane,
          getPanes: () => [pane]
        } as never
      },
      paneTransportsRef: { current: transports },
      paneCwdRef: { current: new Map() },
      fallbackCwd: '/tmp',
      expandedPaneIdRef: { current: null },
      setExpandedPane: noop,
      restoreExpandedLayout: noop,
      refreshPaneSizes: noop,
      persistLayoutSnapshot: noop,
      toggleExpandPane: noop,
      setSearchOpen: noop as never,
      onToggleComposeBox: noop,
      onSearchSelectedText: noop,
      onRequestClosePane: noop,
      onClearPaneScrollback: noop,
      onSetTitle: noop,
      onClearPaneTitle: noop,
      searchOpenRef: { current: false },
      searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
      macOptionAsAltRef: { current: 'false' as const }
    })
  )
}

// Cmd+Left resolves to \x01 (readline Ctrl+A) only under the macOS branch of the shortcut policy.
function cmdArrowLeft(overrides: { isComposing?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'ArrowLeft',
    code: 'ArrowLeft',
    keyCode: 37,
    metaKey: true,
    bubbles: true,
    cancelable: true
  })
  if (overrides.isComposing) {
    // Why: happy-dom's KeyboardEventInit may drop isComposing; pin the real mid-IME event shape.
    Object.defineProperty(event, 'isComposing', { value: true })
  }
  return event
}

describe('a cursor chord pressed during a composition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })
  })

  afterEach(() => {
    // Unmounts the hook (removing its window listener) even when a test's assertion threw first,
    // so a leaked keydown handler cannot stopImmediatePropagation the next test's chord.
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sends the composed syllable before the chord, not after it', () => {
    const { pane, wire } = createHarness()
    const { unmount } = mountShortcuts(pane, wire)

    window.dispatchEvent(cmdArrowLeft({ isComposing: true }))
    expect(wire, 'chord must not reach the pty while the glyph is pending').toEqual([])

    // The pending glyph commits into the terminal, then the chord fires one macrotask later.
    pane.terminal.element.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    expect(wire).toEqual(['다', '\x01'])
    unmount()
  })

  it('does not fall back to a timer while the composition is still open', () => {
    const { pane, wire } = createHarness()
    const { unmount } = mountShortcuts(pane, wire)

    window.dispatchEvent(cmdArrowLeft({ isComposing: true }))
    vi.advanceTimersByTime(30_000)

    expect(wire).toEqual([])
    unmount()
  })

  it('sends immediately when no composition is in flight', () => {
    const { pane, wire } = createHarness()
    const { unmount } = mountShortcuts(pane, wire)

    window.dispatchEvent(cmdArrowLeft())

    expect(wire).toEqual(['\x01'])
    unmount()
  })

  // STA-4476: an indefinite wait has no exit of its own. Without an owner the listener outlives the
  // pane and a later composition on the same element flushes the stale chord against a rebound pty.
  it('drops the held chord and its listener when the pane tears down', () => {
    const { pane, wire, deferralListenerCount } = createHarness()
    const { unmount } = mountShortcuts(pane, wire)

    window.dispatchEvent(cmdArrowLeft({ isComposing: true }))
    expect(deferralListenerCount()).toBeGreaterThan(0)

    unmount()
    pane.terminal.element.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    // The glyph still commits, but the chord that outlived the pane must not reach the pty.
    expect(wire).toEqual(['다'])
    expect(deferralListenerCount()).toBe(0)
  })

  it('drops the held chord and its listener on blur', () => {
    const { pane, wire, deferralListenerCount } = createHarness()
    const { unmount } = mountShortcuts(pane, wire)

    window.dispatchEvent(cmdArrowLeft({ isComposing: true }))
    window.dispatchEvent(new Event('blur'))
    pane.terminal.element.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    expect(wire).toEqual(['다'])
    expect(deferralListenerCount()).toBe(0)
    unmount()
  })

  // A composition that never commits must not strand the wait forever. The chord is discarded,
  // never sent late — a late send is #12871 again.
  it('abandons a chord whose composition never ends', () => {
    const { pane, wire, deferralListenerCount } = createHarness()
    const { unmount } = mountShortcuts(pane, wire)

    window.dispatchEvent(cmdArrowLeft({ isComposing: true }))
    vi.advanceTimersByTime(TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS + 1)
    pane.terminal.element.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    expect(wire).toEqual(['다'])
    expect(deferralListenerCount()).toBe(0)
    unmount()
  })
})
