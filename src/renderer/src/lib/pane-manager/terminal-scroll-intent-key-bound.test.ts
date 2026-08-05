import { describe, expect, it, vi } from 'vitest'
import { bindTerminalScrollIntentKey, markTerminalPinnedViewport } from './terminal-scroll-intent'

function createTerminal(viewportY = 5, baseY = 100) {
  const terminal = {
    buffer: { active: { type: 'normal' as const, viewportY, baseY } },
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn()
  }
  return terminal
}

// Why: the by-key maps are durable across a pane's unmount, so they can only be bounded,
// not cleared on dispose. These lock the bound in without regressing pin-restore.
describe('terminal scroll intent by-key bound', () => {
  it('restores a pinned intent for a key that is still hot', () => {
    const first = createTerminal()
    bindTerminalScrollIntentKey(first, 'hot-key')
    markTerminalPinnedViewport(first)

    // A remount binds a fresh terminal object to the same persisted leaf id.
    const remounted = createTerminal()
    expect(bindTerminalScrollIntentKey(remounted, 'hot-key')).toBeDefined()
  })

  it('ages out the oldest key once the bound is exceeded', () => {
    const oldest = createTerminal()
    bindTerminalScrollIntentKey(oldest, 'evict-me')
    markTerminalPinnedViewport(oldest)

    // 256 is the bound; write well past it so 'evict-me' is guaranteed to fall off.
    for (let i = 0; i < 300; i += 1) {
      const terminal = createTerminal()
      bindTerminalScrollIntentKey(terminal, `filler-${i}`)
      markTerminalPinnedViewport(terminal)
    }

    const remounted = createTerminal()
    expect(bindTerminalScrollIntentKey(remounted, 'evict-me')).toBeUndefined()
  })

  it('keeps a recently written key while evicting older ones', () => {
    for (let i = 0; i < 300; i += 1) {
      const terminal = createTerminal()
      bindTerminalScrollIntentKey(terminal, `sweep-${i}`)
      markTerminalPinnedViewport(terminal)
    }

    const recent = createTerminal()
    expect(bindTerminalScrollIntentKey(recent, 'sweep-299')).toBeDefined()
    const stale = createTerminal()
    expect(bindTerminalScrollIntentKey(stale, 'sweep-0')).toBeUndefined()
  })
})
