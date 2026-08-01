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

// The pane half of the tail, in the order a restored boot emits it. rendererT is
// the one renderer clock all these milestones share.
function paneBootEvents() {
  const lines = [
    ['[startup] renderer-aterm-worker-ready t=1520 rendererT=610', 1530],
    ['[startup] renderer-pane-boot-start t=1700 rendererT=790', 1712],
    ['[startup] renderer-pane-layout-replayed t=1720 rendererT=810', 1731],
    ['[startup] renderer-pane-scrollback-restored t=1760 rendererT=850', 1770],
    ['[startup] renderer-pane-boot-settled t=1770 rendererT=860', 1780],
    ['[startup] renderer-pane-pty-connect-start t=1786 rendererT=876', 1795],
    ['[startup] renderer-pane-fit-measured t=1787 rendererT=877', 1796],
    ['[startup] renderer-pane-pty-bound t=1870 rendererT=960', 1881]
  ]
  return lines.map(([line, harnessMs]) => ({ ...parseStartupLine(line), harnessMs }))
}

describe('derivePhases pane-boot lane', () => {
  it('splits worker-ready → first frame into the pane boot stages', () => {
    const phases = derivePhases([...restoredRunEvents(), ...paneBootEvents()])
    expect(phases.totalToPaneBootStart).toBe(1712)
    expect(phases.paneBootStartToLayoutReplayed).toBe(20)
    expect(phases.paneLayoutReplayedToScrollbackRestored).toBe(40)
    expect(phases.paneScrollbackRestoredToBootSettled).toBe(10)
    // fit and the deferred connect both measure from boot-settled, not each other.
    expect(phases.paneBootSettledToPtyConnectStart).toBe(16)
    expect(phases.paneBootSettledToFitMeasured).toBe(17)
    expect(phases.panePtyConnectStartToPtyBound).toBe(84)
    expect(phases.paneBootStartToFirstTerminalFrame).toBe(150)
    expect(phases.paneBootSettledToFirstTerminalFrame).toBe(80)
  })

  it('reports a negative pty-bound → first-frame delta when the paint beats the daemon', () => {
    // first-terminal-frame rendererT=940 lands before pty-bound rendererT=960.
    const phases = derivePhases([...restoredRunEvents(), ...paneBootEvents()])
    expect(phases.panePtyBoundToFirstTerminalFrame).toBe(-20)
  })

  it('yields null (not NaN) for every pane phase when no terminal restores', () => {
    const phases = derivePhases(restoredRunEvents())
    for (const name of [
      'totalToPaneBootStart',
      'paneBootStartToLayoutReplayed',
      'paneLayoutReplayedToScrollbackRestored',
      'paneScrollbackRestoredToBootSettled',
      'paneBootSettledToFitMeasured',
      'paneBootSettledToPtyConnectStart',
      'panePtyConnectStartToPtyBound',
      'panePtyBoundToFirstTerminalFrame',
      'paneBootStartToFirstTerminalFrame',
      'paneBootSettledToFirstTerminalFrame'
    ]) {
      expect(phases[name], name).toBeNull()
    }
  })

  it('falls back to harness arrival times when a pane milestone lost its clocks', () => {
    const events = [...restoredRunEvents(), ...paneBootEvents()].map((event) =>
      event.event === 'renderer-pane-boot-start' ? { ...event, details: {} } : event
    )
    const phases = derivePhases(events)
    expect(phases.paneBootStartToLayoutReplayed).toBe(1731 - 1712)
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
