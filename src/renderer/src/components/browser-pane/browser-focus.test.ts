// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  consumeBrowserFocusRequest,
  queueBrowserFocusRequest,
  requestBrowserFocus
} from './browser-focus'

describe('browser-focus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues and consumes one browser focus request per page id', () => {
    queueBrowserFocusRequest({ pageId: 'page-1', target: 'webview' })

    expect(consumeBrowserFocusRequest('page-1')).toBe('webview')
    expect(consumeBrowserFocusRequest('page-1')).toBeNull()
  })

  it('overwrites older requests for the same page id', () => {
    queueBrowserFocusRequest({ pageId: 'page-2', target: 'webview' })
    queueBrowserFocusRequest({ pageId: 'page-2', target: 'address-bar' })

    expect(consumeBrowserFocusRequest('page-2')).toBe('address-bar')
  })

  it('returns null for a page id that was never queued', () => {
    expect(consumeBrowserFocusRequest('nonexistent-page')).toBeNull()
  })

  it('requestBrowserFocus both queues the target and announces it to live listeners', () => {
    const detail = { pageId: 'page-request', target: 'address-bar' } as const
    const announced: CustomEvent[] = []
    const onFocusRequest = (event: Event): void => {
      announced.push(event as CustomEvent)
    }
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, onFocusRequest)

    requestBrowserFocus(detail)
    window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, onFocusRequest)

    // A pane mounting after the event still reads the queued target.
    expect(consumeBrowserFocusRequest('page-request')).toBe('address-bar')
    // A pane already listening hears it synchronously.
    expect(announced[0]?.detail).toEqual(detail)
  })

  it('expires unconsumed requests for pages that never mount', () => {
    vi.useFakeTimers()

    queueBrowserFocusRequest({ pageId: 'page-stale', target: 'webview' })

    vi.advanceTimersByTime(30_000)

    expect(consumeBrowserFocusRequest('page-stale')).toBeNull()
  })
})
