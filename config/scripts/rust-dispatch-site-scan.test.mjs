// What the orphan report is allowed to call "a resolved dispatch", and what it
// must instead surface as unresolvable.
//
// The failures these pin down are the ones that defeated the previous gate: a
// module key that is only a TYPE, a door reached through a value, and a
// per-function door cross-attributed to a module. Each fixture is driven through
// `scanDispatchSitesInProject` — the exact function the report calls — so a
// refusal that stops being wired stops passing here.

import { describe, expect, it } from 'vitest'

import { resolveDoorSurface } from './rust-dispatch-keyed-doors.mjs'
import { scanDispatchSitesInProject } from './rust-dispatch-site-scan.mjs'
import { createInMemoryProject } from './typescript-symbol-resolution.mjs'

const FIXTURE_ROOT = '__semantic-gate-fixture__'

const SEAM_SOURCE = `
export function requireOrcaDispatch(module: string, fn: string, input: unknown): unknown {
  return JSON.parse(String(module) + String(fn) + JSON.stringify(input))
}
export function deriveGeneratedTabTitle(input: string): string {
  return input
}
`

const KEYED_DOOR = Object.freeze({
  id: 'fixture-seam',
  kind: 'module-exports',
  moduleFile: `${FIXTURE_ROOT}/seam.ts`,
  keyed: ['requireOrcaDispatch'],
  moduleArgIndex: 0,
  perFunctionDoors: true,
  why: 'fixture'
})

/** Everything under the fixture root counts as production, so the fixture does
 *  not have to imitate the repo's src/ layout. */
function scanFixture(files) {
  const project = createInMemoryProject({ 'seam.ts': SEAM_SOURCE, ...files })
  return scanDispatchSitesInProject(project, {
    doors: [KEYED_DOOR],
    isProduction: () => true
  })
}

function keysOf(result) {
  return result.resolved.map((site) => site.moduleKey).sort()
}

function kindsOf(result) {
  return [...new Set(result.unresolvable.map((site) => site.kind))].sort()
}

describe('resolveDoorSurface', () => {
  it('separates the keyed aggregate from the per-function Rust doors', () => {
    const project = createInMemoryProject({ 'seam.ts': SEAM_SOURCE })
    const surface = resolveDoorSurface(project, KEYED_DOOR)
    expect([...surface.keyed.values()]).toEqual(['requireOrcaDispatch'])
    expect([...surface.perFunction.values()]).toEqual(['deriveGeneratedTabTitle'])
    expect(surface.missing).toEqual([])
  })

  it('reports a declared keyed door that no longer exists rather than resolving nothing quietly', () => {
    const project = createInMemoryProject({ 'seam.ts': 'export function unrelated(): void {}\n' })
    const surface = resolveDoorSurface(project, KEYED_DOOR)
    expect(surface.missing).toEqual(['requireOrcaDispatch'])
  })
})

describe('a module key is read as a literal node only', () => {
  it('resolves a genuine string-literal argument', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        export function run(): unknown {
          return requireOrcaDispatch('ported-module', 'fn', {})
        }
      `
    })
    expect(keysOf(result)).toEqual(['ported-module'])
    expect(result.unresolvable).toEqual([])
  })

  it('resolves through a renamed import — identity is the declaration, not the text', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch as go } from './seam'
        export function run(): unknown {
          return go('ported-module', 'fn', {})
        }
      `
    })
    expect(keysOf(result)).toEqual(['ported-module'])
  })

  it('resolves nothing for a local shadow that merely shares the name', () => {
    const result = scanFixture({
      'caller.ts': `
        function requireOrcaDispatch(module: string, fn: string, input: unknown): unknown {
          return { module, fn, input }
        }
        export function run(): unknown {
          return requireOrcaDispatch('ported-module', 'fn', {})
        }
      `
    })
    expect(result.resolved).toEqual([])
    expect(result.unresolvable).toEqual([])
  })

  it('refuses an ambient const whose TYPE is a string literal, and says so', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        declare const KEY: 'ported-module'
        export function run(): unknown {
          return requireOrcaDispatch(KEY, 'fn', {})
        }
      `
    })
    expect(keysOf(result)).toEqual([])
    expect(kindsOf(result)).toEqual(['module-key-is-not-a-literal'])
  })

  it('refuses a cast to a string-literal type', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        export function run(): unknown {
          return requireOrcaDispatch(null as unknown as 'ported-module', 'fn', {})
        }
      `
    })
    expect(keysOf(result)).toEqual([])
    expect(kindsOf(result)).toEqual(['module-key-is-not-a-literal'])
  })

  it("refuses a literal-typed parameter, reporting it as the caller's forward", () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        export function run(key: 'ported-module'): unknown {
          return requireOrcaDispatch(key, 'fn', {})
        }
      `
    })
    expect(keysOf(result)).toEqual([])
    expect(kindsOf(result)).toEqual(['module-key-forwarded-from-a-parameter'])
  })

  it('refuses a template with a substitution', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        const suffix = 'module'
        export function run(): unknown {
          return requireOrcaDispatch(\`ported-\${suffix}\`, 'fn', {})
        }
      `
    })
    expect(keysOf(result)).toEqual([])
    expect(kindsOf(result)).toEqual(['module-key-is-not-a-literal'])
  })
})

describe('doors reached in ways that name no module', () => {
  it('reports a keyed door held as a value instead of treating the modules as orphans quietly', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        export const indirect = requireOrcaDispatch
      `
    })
    expect(result.resolved).toEqual([])
    expect(kindsOf(result)).toEqual(['keyed-door-escapes-as-value'])
  })

  it('reports a per-function door as unattributable and never as a module key', () => {
    const result = scanFixture({
      'caller.ts': `
        import { deriveGeneratedTabTitle } from './seam'
        export function run(): string {
          return deriveGeneratedTabTitle('agent-tab-title')
        }
      `
    })
    // The literal 'agent-tab-title' sits in the argument slot, but the door is
    // per-function: attributing it would be the cross-attribution forgery.
    expect(result.resolved).toEqual([])
    expect(kindsOf(result)).toEqual(['unattributable-per-function-door'])
  })

  it('does not count a call the language proves is never taken', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        export function run(): unknown {
          if (false) {
            return requireOrcaDispatch('ported-module', 'fn', {})
          }
          return null
        }
      `
    })
    expect(result.resolved).toEqual([])
  })

  it('does not count an erased type-only reference', () => {
    const result = scanFixture({
      'caller.ts': `
        import type { requireOrcaDispatch } from './seam'
        export type Door = typeof requireOrcaDispatch
      `
    })
    expect(result.resolved).toEqual([])
    expect(result.unresolvable).toEqual([])
  })

  it('does not report the import binding itself as reach into Rust', () => {
    const result = scanFixture({
      'caller.ts': `
        import { requireOrcaDispatch } from './seam'
        export function run(): unknown {
          return requireOrcaDispatch('ported-module', 'fn', {})
        }
      `
    })
    expect(result.unresolvable).toEqual([])
    expect(result.resolved).toHaveLength(1)
  })
})
