import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  track: vi.fn(),
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/telemetry', () => ({ track: mocks.track }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import {
  _resetGitWasmAvailabilityForTests,
  getGitWasmAvailability,
  isGitWasmUnavailable
} from './git-wasm-availability'
import {
  _resetGitWasmUnavailableReportForTests,
  reportGitWasmUnavailable
} from './git-wasm-unavailable-report'

beforeEach(() => {
  _resetGitWasmAvailabilityForTests()
  _resetGitWasmUnavailableReportForTests()
  mocks.toastError.mockClear()
  mocks.track.mockClear()
  mocks.recordRendererCrashBreadcrumb.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('reportGitWasmUnavailable', () => {
  it('records the failure through telemetry and the crash breadcrumb trail', () => {
    reportGitWasmUnavailable(new WebAssembly.CompileError('unreachable opcode'))

    expect(mocks.track).toHaveBeenCalledWith('git_wasm_unavailable', {
      error_class: 'compile_failed'
    })
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith('git_wasm_unavailable', {
      error_class: 'compile_failed'
    })
  })

  it('flips the queryable degraded state so a shim can tell dead from not-yet-ready', () => {
    expect(isGitWasmUnavailable()).toBe(false)

    reportGitWasmUnavailable(new Error('boom'))

    expect(isGitWasmUnavailable()).toBe(true)
    expect(getGitWasmAvailability()).toBe('unavailable')
  })

  it('surfaces one persistent, dismissible toast — not a modal and not a per-caller stack', () => {
    reportGitWasmUnavailable(new Error('boom'))

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.toastError.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('Orca is running with reduced features.')
    expect(options.id).toBe('git-wasm-unavailable')
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    expect(String(options.description)).toContain('Relaunch Orca')
  })

  it('reports once per session even though several boot paths observe the same rejection', () => {
    const error = new Error('boom')
    reportGitWasmUnavailable(error)
    reportGitWasmUnavailable(error)
    reportGitWasmUnavailable(error)

    expect(mocks.track).toHaveBeenCalledTimes(1)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('never lets a raw error reach the wire — only the bucketed class', () => {
    reportGitWasmUnavailable(new TypeError('Failed to fetch /home/someone/orca/out/core.wasm'))

    const props = mocks.track.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(props)).toEqual(['error_class'])
    expect(props.error_class).toBe('fetch_failed')
  })
})
