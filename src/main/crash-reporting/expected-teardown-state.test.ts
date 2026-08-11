import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => []
  }
}))

import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import {
  markSystemSessionEnding,
  resetExpectedTeardownStateForTest,
  resolveExpectedTeardownScope,
  WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
} from './expected-teardown-state'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'

function currentTeardownScope(includeSystemSessionEnd = true) {
  return resolveExpectedTeardownScope({
    isQuitting: false,
    isQuittingForUpdate: false,
    isExpectedRendererReload: false,
    includeSystemSessionEnd
  })
}

function killedRenderer(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    ...overrides
  }
}

let now: number

beforeEach(() => {
  now = 1_000
  resetExpectedTeardownStateForTest(() => now)
  clearCrashBreadcrumbsForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetExpectedTeardownStateForTest()
  clearCrashBreadcrumbsForTest()
})

describe('expected teardown state — Windows OS session-end', () => {
  it('bounds the suppression window to a product-chosen five seconds', () => {
    expect(WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS).toBe(5_000)
  })

  it('does NOT file the killed renderer that follows a Windows OS shutdown as a crash', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    // OS shutdown/restart records session-end, then tears down the renderer as killed/1.
    markSystemSessionEnding()
    const expectedTeardown = currentTeardownScope()
    recordProcessGoneCrash(
      { record } as never,
      killedRenderer({ expectedTeardown }),
      new ProcessGoneDedupe()
    )

    expect(expectedTeardown).toBe('app-shutdown')
    expect(record).not.toHaveBeenCalled()
  })

  it('still files a genuine renderer crash while no teardown is in flight', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    const expectedTeardown = currentTeardownScope()
    recordProcessGoneCrash(
      { record } as never,
      killedRenderer({ reason: 'crashed', exitCode: 5, expectedTeardown }),
      new ProcessGoneDedupe()
    )

    expect(expectedTeardown).toBe('none')
    expect(record).toHaveBeenCalledOnce()
  })

  it('still files a lone killed renderer with no session-end intent', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    const expectedTeardown = currentTeardownScope()
    recordProcessGoneCrash(
      { record } as never,
      killedRenderer({ expectedTeardown }),
      new ProcessGoneDedupe()
    )

    expect(expectedTeardown).toBe('none')
    expect(record).toHaveBeenCalledOnce()
  })

  it('classifies a kill just inside the window as app-shutdown but not at/after the boundary', () => {
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS - 1
    const insideScope = currentTeardownScope()

    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
    const boundaryScope = currentTeardownScope()

    expect(insideScope).toBe('app-shutdown')
    expect(boundaryScope).toBe('none')
  })

  it('durably files the killed renderer once the session-end window expires', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
    const expectedTeardown = currentTeardownScope()
    recordProcessGoneCrash(
      { record } as never,
      killedRenderer({ expectedTeardown }),
      new ProcessGoneDedupe()
    )

    expect(expectedTeardown).toBe('none')
    expect(record).toHaveBeenCalledOnce()
  })

  it('does not resurrect a stale session-end after a clock backtrack', () => {
    markSystemSessionEnding()
    now -= 1
    const backtrackScope = currentTeardownScope()
    // A subsequent catch-up must not re-open the window either.
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
    const catchUpScope = currentTeardownScope()

    expect(backtrackScope).toBe('none')
    expect(catchUpScope).toBe('none')
  })

  it('re-arms the window on repeated session-end events', () => {
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS - 1
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS - 1

    expect(currentTeardownScope()).toBe('app-shutdown')
  })

  it('excludes session-end from the recovery path while preserving in-app quit suppression', () => {
    markSystemSessionEnding()
    const sessionEndRecoveryScope = currentTeardownScope(false)
    const inAppQuitScope = resolveExpectedTeardownScope({
      isQuitting: true,
      isQuittingForUpdate: false,
      isExpectedRendererReload: false,
      includeSystemSessionEnd: false
    })

    // Recovery must still reload/preserve PTYs during an OS session-end...
    expect(sessionEndRecoveryScope).toBe('none')
    // ...but an in-app quit still blocks recovery.
    expect(inAppQuitScope).toBe('app-shutdown')
  })

  it('preserves existing update and renderer-reload scopes', () => {
    expect(
      resolveExpectedTeardownScope({
        isQuitting: false,
        isQuittingForUpdate: true,
        isExpectedRendererReload: false
      })
    ).toBe('app-shutdown')
    expect(
      resolveExpectedTeardownScope({
        isQuitting: false,
        isQuittingForUpdate: false,
        isExpectedRendererReload: true,
        includeSystemSessionEnd: false
      })
    ).toBe('renderer-reload')
  })
})
