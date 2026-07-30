import { describe, expect, it } from 'vitest'
import {
  assertWaitEventCanFire,
  derivePhases,
  parseStartupLine
} from './startup-milestone-phases.mjs'

// Synthetic event stream shaped like a real restored-local-tabs run: `t` is
// the in-app ms-since-process-start clock, `harnessMs` the stderr arrival time.
function restoredRunEvents() {
  const lines = [
    ['[startup] app-ready t=120', 130],
    ['[startup] window-created t=300', 310],
    ['[startup] did-finish-load t=900', 910],
    ['[startup] renderer-startup-hydration-done t=1500 rendererT=590', 1512],
    ['[startup] renderer-first-terminal-frame t=1850 rendererT=940', 1863]
  ]
  return lines.map(([line, harnessMs]) => ({ ...parseStartupLine(line), harnessMs }))
}

describe('parseStartupLine', () => {
  it('parses the first-terminal-frame milestone with its clocks', () => {
    const parsed = parseStartupLine('[startup] renderer-first-terminal-frame t=1850 rendererT=940')
    expect(parsed).toEqual({
      event: 'renderer-first-terminal-frame',
      details: { t: 1850, rendererT: 940 }
    })
  })
})

describe('derivePhases first-terminal-frame lane', () => {
  it('reports harness total and in-app workspace-ready delta', () => {
    const phases = derivePhases(restoredRunEvents())
    expect(phases.totalToFirstTerminalFrame).toBe(1863)
    // In-app t clocks preferred: 1850 - 1500, not 1863 - 1512.
    expect(phases.workspaceReadyToFirstTerminalFrame).toBe(350)
  })

  it('falls back to harness times when a line lost its t detail', () => {
    const events = restoredRunEvents().map((event) =>
      event.event === 'renderer-first-terminal-frame'
        ? { ...event, details: {} }
        : event
    )
    const phases = derivePhases(events)
    expect(phases.workspaceReadyToFirstTerminalFrame).toBe(1863 - 1512)
  })

  it('yields null (not NaN) when the milestone never fires — schema stays compatible', () => {
    const events = restoredRunEvents().filter(
      (event) => event.event !== 'renderer-first-terminal-frame'
    )
    const phases = derivePhases(events)
    expect(phases.totalToFirstTerminalFrame).toBeNull()
    expect(phases.workspaceReadyToFirstTerminalFrame).toBeNull()
    // Pre-existing keys are untouched by the additions.
    expect(phases.totalToDidFinishLoad).toBe(910)
    expect(phases.totalToWorkspaceReady).toBe(1512)
  })
})

describe('assertWaitEventCanFire', () => {
  it('rejects first-terminal-frame waits under --state-profile none, naming the fix', () => {
    expect(() =>
      assertWaitEventCanFire({
        waitForEvent: 'renderer-first-terminal-frame',
        stateProfile: 'none'
      })
    ).toThrow(/restored-local-tabs/)
  })

  it('allows the lane combination and unrelated events', () => {
    expect(() =>
      assertWaitEventCanFire({
        waitForEvent: 'renderer-first-terminal-frame',
        stateProfile: 'restored-local-tabs'
      })
    ).not.toThrow()
    expect(() =>
      assertWaitEventCanFire({ waitForEvent: 'did-finish-load', stateProfile: 'none' })
    ).not.toThrow()
  })
})
