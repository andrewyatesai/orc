import { describe, expect, it } from 'vitest'
import { INSTALL_FAILURE_CAUSE_MAX_LENGTH, withInstallFailureCause } from './install-failure-cause'

const BASE = 'Could not restart to install the update. Quit and reopen Orca, then try again.'

describe('withInstallFailureCause', () => {
  it('appends the native error text so the reason is not destroyed', () => {
    expect(
      withInstallFailureCause(BASE, new Error("No update filepath provided, can't quit and install"))
    ).toBe(`${BASE} (No update filepath provided, can't quit and install)`)
  })

  it('accepts a bare string cause', () => {
    expect(withInstallFailureCause(BASE, 'pkexec must be setuid root')).toBe(
      `${BASE} (pkexec must be setuid root)`
    )
  })

  it('returns only the base copy when there is no usable cause', () => {
    const emptyMessage = ''
    expect(withInstallFailureCause(BASE, new Error(emptyMessage))).toBe(BASE)
    expect(withInstallFailureCause(BASE, new Error('Unknown error'))).toBe(BASE)
    expect(withInstallFailureCause(BASE, undefined)).toBe(BASE)
    expect(withInstallFailureCause(BASE, { code: 1 })).toBe(BASE)
  })

  it('strips control characters and terminal escapes out of the cause', () => {
    const withEscape = withInstallFailureCause(BASE, new Error('boom[31m\nnext\tline'))
    expect(withEscape).toBe(`${BASE} (boom [31m next line)`)
    expect(withEscape).not.toContain('')
    expect(withEscape).not.toContain('\n')
  })

  it('caps the appended cause length', () => {
    const long = 'x'.repeat(INSTALL_FAILURE_CAUSE_MAX_LENGTH + 50)
    const result = withInstallFailureCause(BASE, new Error(long))
    expect(result).toBe(`${BASE} (${'x'.repeat(INSTALL_FAILURE_CAUSE_MAX_LENGTH)})`)
  })

  it('returns a Windows signature verdict verbatim so UpdateCard can route it', () => {
    const verdict =
      'New version 1.4.200 is not signed by the application owner: publisherNames: Orca'
    expect(withInstallFailureCause(BASE, new Error(verdict))).toBe(verdict)
  })
})
