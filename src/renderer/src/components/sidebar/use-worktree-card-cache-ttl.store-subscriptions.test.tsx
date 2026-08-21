// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
// Side effect: importing the real store installs the listener census counted below.
import '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { GlobalSettings } from '../../../../shared/types'
import { useWorktreeCardCacheTtlMs } from './use-worktree-card-cache-ttl'

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function unmount(): void {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
}

function listenerCount(): number {
  const count = readStoreListenerCount()
  if (count === null) {
    throw new Error('store listener census unavailable')
  }
  return count
}

function makeSettings(promptCacheTtlMs: number): GlobalSettings {
  return { promptCacheTimerEnabled: true, promptCacheTtlMs } as GlobalSettings
}

afterEach(() => {
  unmount()
})

describe('useWorktreeCardCacheTtlMs store subscriptions', () => {
  it('opens no store listener — the TTL is derived from the passed settings', () => {
    const baseline = listenerCount()
    function Probe(): null {
      useWorktreeCardCacheTtlMs(makeSettings(300_000), true)
      return null
    }

    // Why: promptCacheTtlMs lives in the settings the card already subscribes to, so
    // this seam must not open a separate subscription for the same field.
    mount(<Probe />)
    expect(listenerCount() - baseline).toBe(0)

    unmount()
    expect(listenerCount()).toBe(baseline)
  })

  it('reads the cache TTL from the passed settings', () => {
    let cacheTtlMs = -1
    function Probe({ ttl }: { ttl: number }): null {
      cacheTtlMs = useWorktreeCardCacheTtlMs(makeSettings(ttl), true)
      return null
    }

    mount(<Probe ttl={300_000} />)
    expect(cacheTtlMs).toBe(300_000)

    act(() => root?.render(<Probe ttl={120_000} />))
    expect(cacheTtlMs).toBe(120_000)
  })

  it('reports no TTL while the aggregate cache timer is suppressed', () => {
    let cacheTtlMs = -1
    function Probe(): null {
      cacheTtlMs = useWorktreeCardCacheTtlMs(makeSettings(300_000), false)
      return null
    }

    mount(<Probe />)
    expect(cacheTtlMs).toBe(0)
  })
})
