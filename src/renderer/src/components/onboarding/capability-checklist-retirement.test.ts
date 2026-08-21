import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guards #13509: the onboarding capability checklist is retired — its components stay
// deleted and unreferenced by the capability-setup surfaces, so a re-import fails here.
const RETIRED_COMPONENTS = ['AgentFeatureSetupStep', 'FeatureSetupChecklist'] as const
const SETUP_SURFACE_DIRS = [
  new URL('.', import.meta.url),
  new URL('../feature-wall/', import.meta.url)
]

function sourceFiles(dir: URL): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter(
      (name) =>
        (name.endsWith('.ts') || name.endsWith('.tsx')) &&
        name !== 'capability-checklist-retirement.test.ts'
    )
    .map((name) => ({ name, text: readFileSync(fileURLToPath(new URL(name, dir)), 'utf8') }))
}

describe('capability checklist retirement', () => {
  it('leaves no retired checklist component file in the onboarding directory', () => {
    const names = readdirSync(new URL('.', import.meta.url))
    for (const component of RETIRED_COMPONENTS) {
      expect(names).not.toContain(`${component}.tsx`)
      expect(names).not.toContain(`${component}.test.tsx`)
    }
  })

  it('leaves the setup surfaces free of references to the retired checklist', () => {
    for (const dir of SETUP_SURFACE_DIRS) {
      for (const { name, text } of sourceFiles(dir)) {
        for (const component of RETIRED_COMPONENTS) {
          expect(text, `${name} references retired ${component}`).not.toContain(component)
        }
      }
    }
  })
})
