import { describe, expect, it } from 'vitest'
import { getUpdateInstallMode, usesSelfManagedCheck } from './updater-install-policy'

describe('updater install policy', () => {
  it('swaps the bundle in place on darwin, so signing is not an update requirement', () => {
    expect(getUpdateInstallMode('darwin')).toBe('bundle-swap')
  })

  it('uses manual releases on win32 until ALab has a stable publisher identity', () => {
    expect(getUpdateInstallMode('win32')).toBe('manual')
  })

  it('uses manual releases on Linux until each package topology has an apply path', () => {
    expect(getUpdateInstallMode('linux')).toBe('manual')
  })
})

describe('usesSelfManagedCheck', () => {
  it('is true for every mode that resolves the release itself', () => {
    expect(usesSelfManagedCheck('manual')).toBe(true)
    expect(usesSelfManagedCheck('bundle-swap')).toBe(true)
  })

  it('is false only when electron-updater picks the release', () => {
    expect(usesSelfManagedCheck('automatic')).toBe(false)
  })
})
