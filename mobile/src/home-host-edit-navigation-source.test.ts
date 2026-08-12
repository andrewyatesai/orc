import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const homeSource = readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8')

describe('Home host edit navigation wiring', () => {
  it('uses the cold-navigator-safe edit transition', () => {
    expect(homeSource).toMatch(/const openMobileHostEdit = useOpenMobileHostEdit\(\)/)
    expect(homeSource).toMatch(/openMobileHostEdit\(host\.id\)/)
  })

  it('does not deep-push the Edit route directly (breaks for cold/disconnected hosts)', () => {
    expect(homeSource).not.toMatch(/router\.push\(`\/h\/\$\{host\.id\}\/edit`\)/)
  })
})
