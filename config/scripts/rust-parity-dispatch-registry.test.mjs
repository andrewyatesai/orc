// The split this module drives decides which modules a reader looks at first, and both of its
// failure modes lie: under-reading the registries pushes verified modules into the actionable
// column (the first version did exactly that to the two parity-only oracles), while over-reading
// empties that column and hides a genuinely unchecked port. Neither may happen silently, so a
// registry that cannot be read or parses to nothing throws instead of contributing zero keys.
//
// The actionable column is currently empty — every ported module has a differential check. That is
// the finding, not a reason to delete the section: it is the invariant that makes a new unchecked
// port visible the day it lands.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  parityDispatchedModules,
  partitionByParityCoverage
} from './rust-parity-dispatch-registry.mjs'

const scratch = []

function registryFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-parity-registry-'))
  scratch.push(dir)
  const file = path.join(dir, 'mod.rs')
  fs.writeFileSync(file, body)
  return file
}

afterEach(() => {
  while (scratch.length > 0) {
    fs.rmSync(scratch.pop(), { recursive: true, force: true })
  }
})

describe('reading the Rust parity dispatch registry', () => {
  it('finds the modules the real registries dispatch', () => {
    const keys = parityDispatchedModules()
    // Sampled rather than pinned to a count, so adding a port does not fail this test.
    expect(keys.has('task-claim')).toBe(true)
    expect(keys.has('fleet-identity')).toBe(true)
    expect(keys.size).toBeGreaterThan(50)
  })

  // The regression this scanner already shipped once: reading only orca-dispatch reported
  // `nacl-box` and `orchestration-store` as the only unverified modules in the repo. They are the
  // opposite — parity-only oracles held out of the SHIPPED registry on purpose, because one pulls
  // rusqlite and the other drags the crypto stack into the relay wasm for no caller.
  it('includes the parity-only oracles that live outside the shipped registry', () => {
    const keys = parityDispatchedModules()
    expect(keys.has('nacl-box')).toBe(true)
    expect(keys.has('orchestration-store')).toBe(true)
  })

  it('throws when ANY registry parses to nothing, not just when the union is empty', () => {
    const populated = registryFile('match m { "task-claim" => Some(x), _ => None, }')
    const empty = registryFile('fn main() {}')
    expect(() => parityDispatchedModules([populated, empty])).toThrow(/zero modules/u)
  })

  it('parses the match-arm shape and ignores other string literals', () => {
    const keys = parityDispatchedModules([
      registryFile(`
        pub mod task_claim;
        const NOTE: &str = "not-a-dispatch-arm";
        match module {
          "task-claim" => Some(task_claim::dispatch(function, input)),
          "fleet-identity" => Some(fleet_identity::dispatch(function, input)),
          _ => None,
        }
      `)
    ])
    expect([...keys].sort()).toEqual(['fleet-identity', 'task-claim'])
  })

  // Both of these would otherwise present as "every module is unverified", which reads as a
  // damning finding about the codebase rather than a broken instrument.
  it('throws when the registry cannot be read', () => {
    expect(() => parityDispatchedModules(['/nonexistent/mod.rs'])).toThrow(/cannot read/u)
  })

  it('throws when the arm shape parses to nothing', () => {
    expect(() => parityDispatchedModules([registryFile('fn main() {}')])).toThrow(/zero modules/u)
  })
})

describe('partitioning orphan candidates', () => {
  const orphans = [{ name: 'covered' }, { name: 'bare' }]

  it('separates modules a differential check covers from ones nothing covers', () => {
    const { verified, unverified } = partitionByParityCoverage(orphans, new Set(['covered']))
    expect(verified.map((m) => m.name)).toEqual(['covered'])
    expect(unverified.map((m) => m.name)).toEqual(['bare'])
  })

  it('puts everything in the actionable column when nothing is dispatched', () => {
    const { verified, unverified } = partitionByParityCoverage(orphans, new Set())
    expect(verified).toEqual([])
    expect(unverified).toHaveLength(2)
  })

  it('loses no module across the split', () => {
    const { verified, unverified } = partitionByParityCoverage(orphans, new Set(['covered']))
    expect(verified.length + unverified.length).toBe(orphans.length)
  })
})
