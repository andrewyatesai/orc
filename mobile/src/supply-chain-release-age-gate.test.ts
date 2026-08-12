import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// mobile/ is its own pnpm workspace, so the root .npmrc gate does not reach it.
const mobileNpmrc = readFileSync(new URL('../.npmrc', import.meta.url), 'utf8')
const rootNpmrc = readFileSync(new URL('../../.npmrc', import.meta.url), 'utf8')

const readValue = (npmrc: string, key: string): string | undefined =>
  npmrc.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]

describe('supply-chain release-age gate', () => {
  it('applies the root release-age floor to the mobile workspace', () => {
    expect(readValue(mobileNpmrc, 'minimum-release-age')).toBe('4320')
    expect(readValue(mobileNpmrc, 'minimum-release-age')).toBe(
      readValue(rootNpmrc, 'minimum-release-age')
    )
  })

  it('does not copy the Electron-specific shamefully-hoist into mobile', () => {
    expect(readValue(mobileNpmrc, 'shamefully-hoist')).toBeUndefined()
  })
})
