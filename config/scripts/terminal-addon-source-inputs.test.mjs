import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  newestTerminalAddonSourceMtime,
  terminalAddonSourceInputRoots
} from './terminal-addon-source-inputs.mjs'

const projectDir = path.resolve(import.meta.dirname, '../..')
const addonDir = path.resolve(projectDir, 'native/orca-node')

const temporaryRoots = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('terminal addon source-input freshness probe', () => {
  it('covers every local path dependency the real addon manifest links', () => {
    // The regression this pins: the probe once watched only orca-terminal, so a
    // pre-graft orca_node.node stayed "up to date" while orca-runtime moved and
    // mutation-receipts.test.ts failed 5/5 on the missing napi surface.
    const manifest = readFileSync(path.join(addonDir, 'Cargo.toml'), 'utf8')
    const pathDeps = [...manifest.matchAll(/path\s*=\s*"([^"]+)"/g)].map(([, p]) =>
      path.resolve(addonDir, p)
    )
    expect(pathDeps.length).toBeGreaterThanOrEqual(10)

    const roots = new Set(terminalAddonSourceInputRoots({ addonDir, projectDir }))
    for (const dep of pathDeps) {
      expect(roots, `probe must watch ${dep}`).toContain(path.join(dep, 'src'))
      expect(roots, `probe must watch ${dep}`).toContain(path.join(dep, 'Cargo.toml'))
    }
  })

  it('reports a linked-crate source edit as newer than the installed addon', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'orca-addon-freshness-'))
    temporaryRoots.push(fixture)
    const fixtureAddon = path.join(fixture, 'native/orca-node')
    const crateSrc = path.join(fixture, 'rust/crates/orca-runtime/src')
    mkdirSync(path.join(fixtureAddon, 'src'), { recursive: true })
    mkdirSync(crateSrc, { recursive: true })
    writeFileSync(path.join(fixtureAddon, 'Cargo.toml'), '[package]\n')
    writeFileSync(path.join(fixtureAddon, 'src/lib.rs'), '// addon\n')
    writeFileSync(path.join(crateSrc, 'mutation_receipt.rs'), '// v11\n')

    // Backdate everything, then bump only the linked crate's source.
    const old = new Date('2020-01-01T00:00:00Z')
    for (const p of [
      path.join(fixtureAddon, 'Cargo.toml'),
      path.join(fixtureAddon, 'src/lib.rs'),
      path.join(crateSrc, 'mutation_receipt.rs')
    ]) {
      utimesSync(p, old, old)
    }
    const args = { addonDir: fixtureAddon, projectDir: fixture }
    const installedAt = newestTerminalAddonSourceMtime(args) + 1

    const bumped = new Date()
    utimesSync(path.join(crateSrc, 'mutation_receipt.rs'), bumped, bumped)
    expect(newestTerminalAddonSourceMtime(args)).toBeGreaterThan(installedAt)
  })

  it('is the probe build-terminal-addon.mjs actually consults', () => {
    // Tripwire: extracting the probe must not let the gate silently de-wire it.
    const gate = readFileSync(path.join(import.meta.dirname, 'build-terminal-addon.mjs'), 'utf8')
    expect(gate).toContain('newestTerminalAddonSourceMtime({ addonDir, projectDir })')
  })
})
