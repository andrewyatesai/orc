// Fork adaptation of upstream's terminal-visibility-resume.test.ts: the
// xterm-era reveal-repaint assertions (scheduleRevealRepaint /
// scheduleRevealPresent / fitAllRevealedPanes) were superseded by the fork's
// aterm resume architecture (write-freeze + re-anchor, registry re-present;
// also covered by the scroll-intent and pane-lifecycle suites). What survives
// is re-expressed against the fork's seams: the upstream #9061/#9659 link-hover
// coverage, the pre-resume intent latch, and the post-paint recovery pass.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  recoverVisibleTerminalWindowWake,
  resumeTerminalVisibility
} from './terminal-visibility-resume'

vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  resetAllTerminalWebglAtlases: vi.fn(),
  resetAndRefreshAllTerminalWebglAtlases: vi.fn()
}))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: vi.fn(),
  requestTerminalBacklogRecovery: vi.fn()
}))
vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  beginSuppressScrollIntentWrites: vi.fn(),
  endSuppressScrollIntentWrites: vi.fn(),
  enforceTerminalCurrentScrollIntent: vi.fn(),
  syncTerminalScrollIntentFromViewport: vi.fn()
}))
vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  focusActivePane: vi.fn()
}))
const scheduleTabRevealWebglAtlasRecovery = vi.fn()
vi.mock('./terminal-webgl-atlas-recovery', () => ({
  // Why: the light-tab reveal must recover the atlas immediately, decoupled from
  // the terminal-output debounce (which a background stream could otherwise defer).
  scheduleTabRevealWebglAtlasRecovery: () => scheduleTabRevealWebglAtlasRecovery()
}))
const resetTerminalLinkifierHoverState = vi.fn()
vi.mock('@/lib/pane-manager/terminal-linkifier-hover-reset', () => ({
  resetTerminalLinkifierHoverState: (terminal: unknown) =>
    resetTerminalLinkifierHoverState(terminal)
}))

type FakeManager = PaneManager & {
  getPanes: ReturnType<typeof vi.fn>
  resumeRendering: ReturnType<typeof vi.fn>
  suspendRendering: ReturnType<typeof vi.fn>
  fitAllPanes: ReturnType<typeof vi.fn>
  fitAllRevealedPanes: ReturnType<typeof vi.fn>
}

function createManager(panes: { terminal: unknown }[] = []): FakeManager {
  return {
    getPanes: vi.fn(() => panes),
    resumeRendering: vi.fn(),
    suspendRendering: vi.fn(),
    // Stubbed apart so reveals can be asserted to route through the wobble-
    // resistant fitAllRevealedPanes, never the sync fitAllPanes.
    fitAllPanes: vi.fn(),
    fitAllRevealedPanes: vi.fn()
  } as unknown as FakeManager
}

function resumeArgs(manager: PaneManager, shouldUseLightTabResume: boolean) {
  return {
    manager,
    isActive: true,
    wasVisible: false,
    shouldUseLightTabResume,
    captureViewportPositions: vi.fn(() => new Map())
  }
}

describe('resumeTerminalVisibility link hover recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([true, false])(
    'resets each pane linkifier hover cache on reveal (light=%s) so links recover without a scroll',
    (light) => {
      const first = { name: 'pane-a' }
      const second = { name: 'pane-b' }
      const manager = createManager([{ terminal: first }, { terminal: second }])

      resumeTerminalVisibility(resumeArgs(manager, light))

      expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(first)
      expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(second)
    }
  )
})

describe('resumeTerminalVisibility viewport intent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('captures native trim movement before enforcing viewport intent', async () => {
    const terminal = { name: 'trimmed-terminal' }
    const manager = createManager([{ terminal }])
    const { enforceTerminalCurrentScrollIntent, syncTerminalScrollIntentFromViewport } = vi.mocked(
      await import('@/lib/pane-manager/terminal-scroll-intent')
    )

    resumeTerminalVisibility(resumeArgs(manager, true))

    expect(syncTerminalScrollIntentFromViewport).toHaveBeenCalledWith(terminal)
    expect(syncTerminalScrollIntentFromViewport.mock.invocationCallOrder[0]).toBeLessThan(
      enforceTerminalCurrentScrollIntent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('latches viewport intent once, before a heavy resume restarts drawing', async () => {
    // Why: the pre-resume latch is the durable one. A second, post-flush sync
    // would read pre-parse geometry (flush only queues the engine write) and
    // could overwrite a pin with resume/fit wobble.
    const terminal = { name: 'pinned-heavy' }
    const manager = createManager([{ terminal }])
    const { syncTerminalScrollIntentFromViewport } = vi.mocked(
      await import('@/lib/pane-manager/terminal-scroll-intent')
    )

    resumeTerminalVisibility(resumeArgs(manager, false))

    expect(syncTerminalScrollIntentFromViewport).toHaveBeenCalledTimes(1)
    expect(syncTerminalScrollIntentFromViewport.mock.invocationCallOrder[0]).toBeLessThan(
      manager.resumeRendering.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('freezes intent writes across the resume window', async () => {
    const manager = createManager([{ terminal: { name: 'pane' } }])
    const { beginSuppressScrollIntentWrites } = vi.mocked(
      await import('@/lib/pane-manager/terminal-scroll-intent')
    )

    resumeTerminalVisibility(resumeArgs(manager, false))

    expect(beginSuppressScrollIntentWrites).toHaveBeenCalled()
  })
})

describe('resumeTerminalVisibility resume paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not fit on a light tab reveal', () => {
    const manager = createManager()

    const recovery = resumeTerminalVisibility(resumeArgs(manager, true))

    expect(manager.fitAllRevealedPanes).not.toHaveBeenCalled()
    expect(manager.fitAllPanes).not.toHaveBeenCalled()
    expect(manager.resumeRendering).not.toHaveBeenCalled()
    // Reveal recovery is immediate (not the terminal-output debounce), so a
    // background stream in another pane cannot defer this tab's atlas rebuild.
    expect(scheduleTabRevealWebglAtlasRecovery).toHaveBeenCalledTimes(1)
    // A light reveal has no deferred half.
    expect(recovery).toBeNull()
  })

  it('routes a heavy reveal through fitAllRevealedPanes, not the sync fit', async () => {
    // Regression: the sync reveal fit applied a transient one-column-off grid,
    // garbling diff-painting inline TUIs on restore.
    const manager = createManager()
    const { focusActivePane } = vi.mocked(await import('./pane-helpers'))

    resumeTerminalVisibility(resumeArgs(manager, false))

    expect(manager.resumeRendering).toHaveBeenCalledTimes(1)
    expect(manager.fitAllRevealedPanes).toHaveBeenCalledTimes(1)
    expect(manager.fitAllPanes).not.toHaveBeenCalled()
    expect(focusActivePane).toHaveBeenCalledWith(manager)
    expect(manager.resumeRendering.mock.invocationCallOrder[0]).toBeLessThan(
      manager.fitAllRevealedPanes.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('defers the backlog drain and the cross-manager re-present until after paint', async () => {
    // Why: resume before flush avoids a stale first frame; fit before flush keeps
    // backlog off the transient mid-transition grid; and the cross-manager
    // re-present must stay off the reveal's pre-paint critical path.
    const order: string[] = []
    const manager = createManager([{ terminal: { name: 'pane' } }])
    manager.resumeRendering.mockImplementation(() => order.push('resume'))
    manager.fitAllRevealedPanes.mockImplementation(() => order.push('fit-reveal'))
    const { flushTerminalOutput, requestTerminalBacklogRecovery } = vi.mocked(
      await import('@/lib/pane-manager/pane-terminal-output-scheduler')
    )
    const { resetAllTerminalWebglAtlases } = vi.mocked(
      await import('@/lib/pane-manager/pane-manager-registry')
    )
    flushTerminalOutput.mockImplementation(() => {
      order.push('flush')
    })
    requestTerminalBacklogRecovery.mockImplementation(() => {
      order.push('backlog')
    })

    const recovery = resumeTerminalVisibility(resumeArgs(manager, false))

    expect(order).toEqual(['resume', 'fit-reveal'])
    expect(resetAllTerminalWebglAtlases).not.toHaveBeenCalled()

    recovery?.run(manager)

    expect(order).toEqual(['resume', 'fit-reveal', 'backlog', 'flush'])
    expect(resetAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
  })

  it('re-presents every live pane after a heavy reveal', async () => {
    const manager = createManager()
    const { resetAllTerminalWebglAtlases, resetAndRefreshAllTerminalWebglAtlases } = vi.mocked(
      await import('@/lib/pane-manager/pane-manager-registry')
    )

    resumeTerminalVisibility(resumeArgs(manager, false))?.run(manager)

    expect(resetAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
    // The heavier reset+refresh is reserved for a genuine display wake.
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
  })

  it('retargets post-paint recovery to a replacement manager', async () => {
    // Why: lifecycle effects can swap the PaneManager between the reveal layout
    // pass and the post-paint pass, so the deferred drain must follow the live one.
    const oldManager = createManager()
    const newTerminal = { name: 'replacement' }
    const newManager = createManager([{ terminal: newTerminal }])
    const { flushTerminalOutput } = vi.mocked(
      await import('@/lib/pane-manager/pane-terminal-output-scheduler')
    )
    const { enforceTerminalCurrentScrollIntent } = vi.mocked(
      await import('@/lib/pane-manager/terminal-scroll-intent')
    )

    const recovery = resumeTerminalVisibility(resumeArgs(oldManager, false))
    flushTerminalOutput.mockClear()
    enforceTerminalCurrentScrollIntent.mockClear()

    recovery?.run(newManager)

    expect(flushTerminalOutput).toHaveBeenCalledTimes(1)
    expect(flushTerminalOutput).toHaveBeenCalledWith(newTerminal, { maxChars: 256 * 1024 })
    expect(enforceTerminalCurrentScrollIntent).toHaveBeenCalledWith(newTerminal)
  })
})

describe('recoverVisibleTerminalWindowWake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why: window blur's mouseleave clears the current link but not the hovered-cell
  // cache, so on refocus/wake with a stationary pointer the link stays dead until a
  // scroll unless the wake path resets it too (upstream #9659).
  it.each([true, false])(
    'resets each pane linkifier hover cache on window wake (clearGlyphAtlases=%s)',
    (clearGlyphAtlases) => {
      const first = { name: 'pane-a' }
      const second = { name: 'pane-b' }
      const manager = createManager([{ terminal: first }, { terminal: second }])

      recoverVisibleTerminalWindowWake({ manager, isActive: true, clearGlyphAtlases })

      expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(first)
      expect(resetTerminalLinkifierHoverState).toHaveBeenCalledWith(second)
    }
  )

  it('latches viewport intent before rendering resumes and fits', async () => {
    // Why: resume/fit can move the viewport; syncing after them would re-latch a
    // pinned viewport as followOutput and jump the user to the bottom.
    const terminal = { name: 'pinned-wake' }
    const manager = createManager([{ terminal }])
    const { enforceTerminalCurrentScrollIntent, syncTerminalScrollIntentFromViewport } = vi.mocked(
      await import('@/lib/pane-manager/terminal-scroll-intent')
    )
    const { flushTerminalOutput } = vi.mocked(
      await import('@/lib/pane-manager/pane-terminal-output-scheduler')
    )

    recoverVisibleTerminalWindowWake({ manager, isActive: true, clearGlyphAtlases: false })

    expect(syncTerminalScrollIntentFromViewport).toHaveBeenCalledWith(terminal)
    expect(syncTerminalScrollIntentFromViewport.mock.invocationCallOrder[0]).toBeLessThan(
      manager.resumeRendering.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(manager.resumeRendering.mock.invocationCallOrder[0]).toBeLessThan(
      manager.fitAllRevealedPanes.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    // Why: streaming refocus must latch before the recovered backlog lands, or the
    // flush's transient geometry re-latches a pin as followOutput (upstream #11915).
    expect(syncTerminalScrollIntentFromViewport.mock.invocationCallOrder[0]).toBeLessThan(
      flushTerminalOutput.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    // One pre-resume latch only; no same-tick post-flush re-sync (flush is async).
    expect(syncTerminalScrollIntentFromViewport).toHaveBeenCalledTimes(1)
    expect(enforceTerminalCurrentScrollIntent.mock.invocationCallOrder[0]).toBeGreaterThan(
      manager.fitAllRevealedPanes.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
    )
  })

  it('fits through the revealed path before draining recovered backlog', async () => {
    // Regression: the sync fitAllPanes reflows a mid-transition container; wake
    // recovery must take the wobble-resistant fit, and take it before the flush.
    const manager = createManager([{ terminal: { name: 'pane' } }])
    const { flushTerminalOutput } = vi.mocked(
      await import('@/lib/pane-manager/pane-terminal-output-scheduler')
    )

    recoverVisibleTerminalWindowWake({ manager, isActive: false, clearGlyphAtlases: false })

    expect(manager.fitAllRevealedPanes).toHaveBeenCalledTimes(1)
    expect(manager.fitAllPanes).not.toHaveBeenCalled()
    expect(manager.fitAllRevealedPanes.mock.invocationCallOrder[0]).toBeLessThan(
      flushTerminalOutput.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('clears shared glyph atlases only on genuine wake recovery', async () => {
    const { resetAndRefreshAllTerminalWebglAtlases } = vi.mocked(
      await import('@/lib/pane-manager/pane-manager-registry')
    )
    const manager = createManager()

    recoverVisibleTerminalWindowWake({ manager, isActive: false, clearGlyphAtlases: true })

    expect(resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
  })

  it('keeps the warm glyph atlas on plain-refocus recovery', async () => {
    // Deliberate reversal of the #6354 focus-clear: the cross-manager reset+refresh
    // is frequent-path cost a plain refocus must not pay. Refocus resumes drawing
    // and re-presents the current aterm frame instead.
    const { resetAllTerminalWebglAtlases, resetAndRefreshAllTerminalWebglAtlases } = vi.mocked(
      await import('@/lib/pane-manager/pane-manager-registry')
    )
    const manager = createManager()

    recoverVisibleTerminalWindowWake({ manager, isActive: false, clearGlyphAtlases: false })

    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
    expect(manager.resumeRendering).toHaveBeenCalledTimes(1)
    expect(resetAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
  })
})
