import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { electronViteConfig } from '../../electron.vite.config'
import { createBootstrapFatalExitBanner } from '../../build-plugins/main-startup-bootstrap'
import { BOOTSTRAP_FATAL_EXIT_GUARD_KEY } from '../../src/main/startup/bootstrap-fatal-exit-guard'

const targetConfig = readFileSync('config/electron-vite-target.config.ts', 'utf8')

describe('Electron Vite output contract', () => {
  it('keeps main-process and plain-Node entries at stable CommonJS paths', () => {
    const output = electronViteConfig.main?.build?.rollupOptions?.output
    if (!output || Array.isArray(output)) {
      throw new Error('Expected one main-process output')
    }

    expect(output.format).toBe('cjs')
    expect(output.entryFileNames).toBe('[name].js')
    expect(output.chunkFileNames).toBe('chunks/[name]-[hash].js')
  })

  it('externalizes packaged dependencies but bundles the daemon xterm graph', () => {
    const external = electronViteConfig.main?.build?.rollupOptions?.external
    if (typeof external !== 'function') {
      throw new Error('Expected main-process external predicate')
    }

    expect(external('node-pty', undefined, false)).toBe(true)
    expect(external('@parcel/watcher', undefined, false)).toBe(true)
    expect(external('electron', undefined, false)).toBe(true)
    expect(external('node:fs', undefined, false)).toBe(true)
    expect(external('@xterm/headless', undefined, false)).toBe(false)
    expect(external('@xterm/addon-serialize', undefined, false)).toBe(false)
  })

  it('exits when a static import fails before source error guards load', () => {
    const processMock = new EventEmitter() as EventEmitter & {
      exit: (code: number) => void
      exitCode?: number
    }
    let scheduledExit: (() => void) | null = null
    let exitedWith: number | null = null
    processMock.exit = (code) => {
      exitedWith = code
    }
    const context = {
      process: processMock,
      setImmediate: (callback: () => void) => {
        scheduledExit = callback
      }
    }

    runInNewContext(createBootstrapFatalExitBanner(), context)
    processMock.emit('uncaughtException', new Error("Cannot find module 'zod'"))

    expect(processMock.exitCode).toBe(1)
    expect(scheduledExit).not.toBeNull()
    scheduledExit?.()
    expect(exitedWith).toBe(1)
    expect(context).toHaveProperty(BOOTSTRAP_FATAL_EXIT_GUARD_KEY)
  })

  it('isolates renderer entry side effects behind strict facades', () => {
    expect(electronViteConfig.renderer?.build?.rollupOptions?.preserveEntrySignatures).toBe(
      'strict'
    )
  })

  // Why: without this the bundler may host a module shared by two main entries
  // inside one entry's chunk, then tree-shake the symbol because that entry does
  // not use it — the other entry ships a call to a function nobody exports. That
  // crashed the PACKAGED app before its first window while every dev launch, and
  // all 41k tests, stayed green.
  it('isolates main entry side effects behind strict facades', () => {
    expect(electronViteConfig.main?.build?.rollupOptions?.preserveEntrySignatures).toBe('strict')
  })

  it('rejects prototype properties as build targets', () => {
    expect(targetConfig).toContain('Object.prototype.hasOwnProperty.call(configByTarget, target)')
  })
})
