import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetGitWasmAvailabilityForTests,
  getGitWasmAvailability,
  getGitWasmLoadError,
  isGitWasmReady,
  isGitWasmUnavailable,
  markGitWasmReady,
  markGitWasmUnavailable,
  subscribeGitWasmAvailability
} from './git-wasm-availability'

beforeEach(() => {
  _resetGitWasmAvailabilityForTests()
})

describe('git wasm availability', () => {
  it('starts pending — neither ready NOR unavailable, so a slow compile is not read as a dead core', () => {
    expect(getGitWasmAvailability()).toBe('pending')
    expect(isGitWasmReady()).toBe(false)
    expect(isGitWasmUnavailable()).toBe(false)
    expect(getGitWasmLoadError()).toBeNull()
  })

  it('makes the degraded state queryable and distinguishable from pending', () => {
    const error = new WebAssembly.CompileError('bad magic')
    markGitWasmUnavailable(error)

    expect(getGitWasmAvailability()).toBe('unavailable')
    expect(isGitWasmUnavailable()).toBe(true)
    expect(isGitWasmReady()).toBe(false)
    expect(getGitWasmLoadError()).toBe(error)
  })

  it('notifies subscribers on the failure edge, not only the ready edge', () => {
    const listener = vi.fn()
    subscribeGitWasmAvailability(listener)

    markGitWasmUnavailable(new Error('boom'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores a second failure so the reporter cannot be driven twice', () => {
    const first = new Error('first')
    const listener = vi.fn()
    subscribeGitWasmAvailability(listener)

    markGitWasmUnavailable(first)
    markGitWasmUnavailable(new Error('second'))

    expect(getGitWasmLoadError()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('never demotes a ready core (the test-only sync init can land first)', () => {
    markGitWasmReady()
    markGitWasmUnavailable(new Error('late rejection'))

    expect(getGitWasmAvailability()).toBe('ready')
    expect(isGitWasmUnavailable()).toBe(false)
    expect(getGitWasmLoadError()).toBeNull()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    subscribeGitWasmAvailability(listener)()

    markGitWasmReady()

    expect(listener).not.toHaveBeenCalled()
  })
})
