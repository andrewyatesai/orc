import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why source assertions: index.ts installs the pre-ready setName as an unexported side effect at
// module top level; the guard's own unit test (dev-instance-identity.test.ts) proves the predicate
// but not that production reaches it. This proves the wiring — and, crucially, that it sits BEFORE
// app.whenReady(), the whole point of the fix (Electron binds the safeStorage service name pre-ready).
describe('pre-ready dev app name wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('imports the guard from dev-instance-identity', () => {
    expect(source).toMatch(
      /import \{[^}]*\bshouldApplyPreReadyAppName\b[^}]*\} from '\.\/startup\/dev-instance-identity'/s
    )
  })

  it('applies app.setName under the guard, before app.whenReady()', () => {
    const guardStart = source.indexOf('if (shouldApplyPreReadyAppName(devInstanceIdentity)) {')
    // Search for the setName from the guard so we anchor on the pre-ready call, not the later
    // unconditional post-ready one inside whenReady.
    const preReadySetName = source.indexOf('app.setName(devInstanceIdentity.appName)', guardStart)
    const whenReady = source.indexOf('app.whenReady().then(')

    // Bound every anchor — an unresolved indexOf returns -1 and would make the ordering below pass
    // vacuously.
    expect(guardStart).toBeGreaterThanOrEqual(0)
    expect(preReadySetName).toBeGreaterThan(guardStart)
    expect(whenReady).toBeGreaterThan(preReadySetName)
  })

  it('keeps a second unconditional setName inside whenReady for packaged builds', () => {
    const whenReady = source.indexOf('app.whenReady().then(')
    const postReadySetName = source.indexOf('app.setName(devInstanceIdentity.appName)', whenReady)
    expect(whenReady).toBeGreaterThanOrEqual(0)
    expect(postReadySetName).toBeGreaterThan(whenReady)
  })
})
