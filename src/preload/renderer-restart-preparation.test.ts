import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../shared/types'
import {
  createUpdaterQuitAbortRelay,
  prepareAndInvokeAppRestart,
  prepareRendererForAppRestart
} from './renderer-restart-preparation'

describe('prepareRendererForAppRestart', () => {
  it('aborts when the dispatched shutdown checkpoint prevents unload', async () => {
    const eventTarget = new EventTarget()
    const started = vi.fn()
    const aborted = vi.fn()
    const checkpoint = vi.fn((event: Event) => event.preventDefault())
    eventTarget.addEventListener('restart-started', started)
    eventTarget.addEventListener('restart-aborted', aborted)
    eventTarget.addEventListener('beforeunload', checkpoint)

    await expect(
      prepareRendererForAppRestart(eventTarget, {
        startedEventName: 'restart-started',
        abortedEventName: 'restart-aborted'
      })
    ).rejects.toThrow('Renderer shutdown checkpoint was not completed.')

    expect(started).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(aborted).toHaveBeenCalledTimes(1)
  })
})

describe('prepareAndInvokeAppRestart', () => {
  const options = {
    startedEventName: 'restart-started',
    abortedEventName: 'restart-aborted'
  }

  it('runs the shutdown checkpoint before invoking main', async () => {
    const eventTarget = new EventTarget()
    const order: string[] = []
    eventTarget.addEventListener('beforeunload', () => order.push('checkpoint'))
    const invoke = vi.fn(async () => {
      order.push('invoke')
    })

    await prepareAndInvokeAppRestart(eventTarget, invoke, options)

    expect(order).toEqual(['checkpoint', 'invoke'])
  })

  it('never invokes main and aborts the latch when the checkpoint is refused', async () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('restart-aborted', aborted)
    eventTarget.addEventListener('beforeunload', (event) => event.preventDefault())
    const invoke = vi.fn()

    await expect(prepareAndInvokeAppRestart(eventTarget, invoke, options)).rejects.toThrow(
      'Renderer shutdown checkpoint was not completed.'
    )

    expect(invoke).not.toHaveBeenCalled()
    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('aborts the latch when the main invoke rejects after a clean checkpoint', async () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('restart-aborted', aborted)
    const invoke = vi.fn(async () => {
      throw new Error('main refused')
    })

    await expect(prepareAndInvokeAppRestart(eventTarget, invoke, options)).rejects.toThrow(
      'main refused'
    )

    expect(aborted).toHaveBeenCalledTimes(1)
  })
})

describe('createUpdaterQuitAbortRelay', () => {
  it('resets a prepared update restart when async updater status reports failure', () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('update-restart-aborted', aborted)
    const relay = createUpdaterQuitAbortRelay(eventTarget, 'update-restart-aborted')
    relay.markPrepared()

    relay.handleStatus({ state: 'error', message: 'install failed' } satisfies UpdateStatus)
    relay.handleStatus({ state: 'error', message: 'duplicate failure' } satisfies UpdateStatus)

    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('ignores updater errors when no update restart was prepared', () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener('update-restart-aborted', aborted)
    const relay = createUpdaterQuitAbortRelay(eventTarget, 'update-restart-aborted')

    relay.handleStatus({ state: 'error', message: 'check failed' } satisfies UpdateStatus)

    expect(aborted).not.toHaveBeenCalled()
  })
})

describe('preload restart wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')

  for (const action of ['relaunch', 'restart', 'reload'] as const) {
    it(`gates app:${action} behind the durable checkpoint`, () => {
      expect(source).toContain(
        `prepareAndInvokeAppRestart(window, () => ipcRenderer.invoke('app:${action}'), {`
      )
    })
  }

  it('never lets a destructive app action reach main without a checkpoint', () => {
    expect(source).not.toMatch(
      /(relaunch|restart|reload): \(\): Promise<void> => ipcRenderer\.invoke\('app:/
    )
  })

  it('relays prevented unload and async updater failure IPC into renderer lifecycle events', () => {
    expect(source).toContain("ipcRenderer.on('updater:status'")
    expect(source).toContain('updaterQuitAbortRelay.handleStatus(status)')
    expect(source).toContain("ipcRenderer.on('window:unload-prevented'")
    expect(source).toContain(
      'window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))'
    )
  })

  it('clears the restart latch when main refuses the unload', () => {
    const start = source.indexOf("ipcRenderer.on('window:unload-prevented'")
    const end = source.indexOf('})', start)
    expect(start).toBeGreaterThanOrEqual(0)
    const block = source.slice(start, end)
    expect(block).toContain('window.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))')
  })

  it('marks updater preparation before invoking main and aborts it on immediate IPC failure', () => {
    const start = source.indexOf('quitAndInstall: async (): Promise<void> => {')
    const end = source.indexOf('onStatus: (callback) => {', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const block = source.slice(start, end)
    const prepare = block.indexOf('await prepareRendererForAppRestart(window, {')
    const markPrepared = block.indexOf('updaterQuitAbortRelay.markPrepared()')
    const invoke = block.indexOf("ipcRenderer.invoke('updater:quitAndInstall')")
    const abort = block.indexOf('updaterQuitAbortRelay.abort()')

    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(markPrepared).toBeGreaterThan(prepare)
    expect(invoke).toBeGreaterThan(markPrepared)
    expect(abort).toBeGreaterThan(invoke)
    expect(block).toMatch(
      /try \{\s*return await ipcRenderer\.invoke\('updater:quitAndInstall'\)\s*\} catch \(error\) \{\s*updaterQuitAbortRelay\.abort\(\)\s*throw error\s*\}/
    )
  })
})
