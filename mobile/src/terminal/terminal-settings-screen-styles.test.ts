import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// react-native's index.js is Flow source the vitest transform can't parse; stub the
// only surface the styles module touches. create() is identity in real RN too.
vi.mock('react-native', () => ({
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 }
}))

const { terminalSettingsScreenStyles } = await import('./terminal-settings-screen-styles')

const screenSource = readFileSync(
  new URL('../../app/terminal-settings.tsx', import.meta.url),
  'utf8'
)

describe('terminal settings screen styles', () => {
  it('is the module the screen imports, not a re-inlined StyleSheet', () => {
    expect(screenSource).toContain(
      "import { terminalSettingsScreenStyles as styles } from '../src/terminal/terminal-settings-screen-styles'"
    )
    // Extraction is complete: no inline stylesheet left behind to drift.
    expect(screenSource).not.toContain('StyleSheet.create(')
  })

  it('exports every style key the screen references', () => {
    const referenced = new Set(
      [...screenSource.matchAll(/styles\.([A-Za-z]+)/g)].map((match) => match[1])
    )
    expect(referenced.size).toBeGreaterThan(0)
    for (const key of referenced) {
      expect(terminalSettingsScreenStyles).toHaveProperty(key)
    }
  })
})
