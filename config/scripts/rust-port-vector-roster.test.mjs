// The roster reads a DECLARED field (`rustCrate`) and turns it into a claim about the filesystem.
// Getting that mapping wrong is worse than it sounds: a port that is on disk but unparsed reports
// "rust source not located", which a reader takes as "the port was never written" — the opposite of
// the truth, and in the direction that makes the migration look less real than it is.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadPortedModuleRoster, rustSourceEvidence } from './rust-port-vector-roster.mjs'

const scratchDirs = []

function vectorsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-roster-'))
  scratchDirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body))
  }
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop(), { recursive: true, force: true })
  }
})

describe('rustCrate is parsed in both spellings the corpus actually uses', () => {
  // Both of these name the same file. `crate (module)` was unparsed until 2026-08, so
  // orca-policy::task_claim, orca-policy::fleet_identity and orca-core::fleet_exceptions all
  // reported as missing while sitting on disk.
  it.each([
    ['orca-policy::task_claim', 'rust/crates/orca-policy/src/task_claim.rs'],
    ['orca-policy (task_claim)', 'rust/crates/orca-policy/src/task_claim.rs'],
    ['orca-core (fleet_exceptions)', 'rust/crates/orca-core/src/fleet_exceptions.rs'],
    ['orca-policy (fleet_identity)', 'rust/crates/orca-policy/src/fleet_identity.rs']
  ])('%s resolves to %s', (declared, expectedFile) => {
    const evidence = rustSourceEvidence(declared)
    expect(evidence.reason, `${declared} should resolve`).toBeNull()
    expect(evidence.file).toBe(expectedFile)
    expect(evidence.lines).toBeGreaterThan(0)
  })

  it('a bare crate name still falls back to its lib.rs', () => {
    const evidence = rustSourceEvidence('orca-policy')
    expect(evidence.file).toBe('rust/crates/orca-policy/src/lib.rs')
  })

  it('reports a genuinely absent crate as unlocated rather than inventing a path', () => {
    const evidence = rustSourceEvidence('orca-does-not-exist (nope)')
    expect(evidence.file).toBeNull()
    expect(evidence.reason).toMatch(/not on disk/u)
  })

  it('distinguishes "no rustCrate declared" from "declared but missing"', () => {
    expect(rustSourceEvidence(null).reason).toMatch(/names no rustCrate/u)
  })
})

describe('the candidate set refuses to silently drop a module', () => {
  // A dropped candidate is an orphan that stops being reported while its vector file is still on
  // disk and still counted — the one edit that can hide a finding without deleting anything.
  it('rejects two vectors that declare the same module name', () => {
    const dir = vectorsDir({
      'a.json': { module: 'shared-name' },
      'b.json': { module: 'shared-name' }
    })
    expect(() => loadPortedModuleRoster(dir)).toThrow(/both declare module "shared-name"/u)
  })

  it('falls back to the filename when a vector declares no module', () => {
    const roster = loadPortedModuleRoster(vectorsDir({ 'implicit-name.json': { source: 'x.ts' } }))
    expect([...roster.keys()]).toEqual(['implicit-name'])
  })

  it('refuses an empty corpus rather than reporting zero orphans', () => {
    expect(() => loadPortedModuleRoster(vectorsDir({}))).toThrow(/candidate set would be empty/u)
  })
})
