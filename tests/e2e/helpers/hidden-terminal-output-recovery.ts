import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export type TerminalOutputSchedulerSnapshot = {
  backgroundEnqueueCount: number
  scheduledDrainCount: number
  queuedChars: number
}

type SchedulerDebugWindow = Window & {
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => TerminalOutputSchedulerSnapshot
  }
}

export type HiddenOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
  hiddenRendererMode2031ReplyCount: number
}

type HiddenOutputRecoveryWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string, meta?: { seq?: number; rawLength?: number }) => boolean
  }
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => HiddenOutputDebugSnapshot
  }
  __terminalHiddenSnapshotOverride?: {
    setPending: (
      ptyId: string,
      snapshot: { data: string; cols: number; rows: number; seq?: number }
    ) => void
    resolve: (ptyId: string) => void
    clear: (ptyId: string) => void
  }
}

export async function resetHiddenOutputDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as HiddenOutputRecoveryWindow).__terminalPtyOutputDebug?.reset()
  })
}

export async function readHiddenOutputDebug(page: Page): Promise<HiddenOutputDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as HiddenOutputRecoveryWindow).__terminalPtyOutputDebug?.snapshot() ?? null
  })
}

export async function injectPaneData(
  page: Page,
  paneKey: string,
  data: string,
  meta?: { seq?: number; rawLength?: number }
): Promise<void> {
  const injected = await page.evaluate(
    ({ paneKey, data, meta }) =>
      (window as HiddenOutputRecoveryWindow).__terminalPtyDataInjection?.inject(
        paneKey,
        data,
        meta
      ) ?? false,
    { paneKey, data, meta }
  )
  if (!injected) {
    throw new Error(`No terminal PTY data injector registered for ${paneKey}`)
  }
}

export async function setHiddenSnapshotOverride(
  page: Page,
  ptyId: string,
  snapshot: { data: string; cols: number; rows: number; seq?: number }
): Promise<void> {
  await page.evaluate(
    ({ ptyId, snapshot }) => {
      const api = (window as HiddenOutputRecoveryWindow).__terminalHiddenSnapshotOverride
      if (!api) {
        throw new Error('Hidden snapshot override API unavailable')
      }
      api.setPending(ptyId, snapshot)
      api.resolve(ptyId)
    },
    { ptyId, snapshot }
  )
}

export async function resetTerminalOutputSchedulerDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('Terminal output scheduler debug API unavailable')
    }
    debug.reset()
  })
}

export async function waitForHiddenOutputSchedulerActivity(
  page: Page
): Promise<TerminalOutputSchedulerSnapshot> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const snapshot = (
            window as SchedulerDebugWindow
          ).__terminalOutputSchedulerDebug?.snapshot()
          return snapshot?.backgroundEnqueueCount ?? 0
        }),
      {
        timeout: 5_000,
        message: 'hidden PTY output did not reach the background output scheduler'
      }
    )
    .toBeGreaterThan(0)
  return page.evaluate(() => {
    const snapshot = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug?.snapshot()
    if (!snapshot) {
      throw new Error('Terminal output scheduler debug API unavailable')
    }
    return {
      backgroundEnqueueCount: snapshot.backgroundEnqueueCount,
      scheduledDrainCount: snapshot.scheduledDrainCount,
      queuedChars: snapshot.queuedChars
    }
  })
}
