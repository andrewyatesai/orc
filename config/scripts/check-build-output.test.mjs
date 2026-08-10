// @proves-gate-fires check:build-output
import { copyFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'check-build-output-consistency.mjs'
// The gate derives its repo root from its own location, so a copy under
// <sandbox>/config/scripts reads the sandbox's out/ and never the real one.
const sandboxes = []

/**
 * A minimal but shaped `out/`: a bundled main entry beside the tsc-emitted files the
 * built CLI reaches across trees for, at two depths so a walk that stopped recursing
 * would be visible.
 */
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-build-output-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  const out = path.join(root, 'out')
  await mkdir(scriptDir, { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), path.join(scriptDir, GATE_SCRIPT))

  await mkdir(path.join(out, 'main', 'daemon'), { recursive: true })
  await mkdir(path.join(out, 'main', 'shared'), { recursive: true })
  await mkdir(path.join(out, 'cli', 'cli', 'daemon'), { recursive: true })
  await writeFile(path.join(out, 'main', 'index.js'), 'module.exports = { app: true }\n')
  await writeFile(path.join(out, 'main', 'daemon', 'client.js'), 'exports.connect = () => {}\n')
  await writeFile(path.join(out, 'main', 'shared', 'ipc-contract.js'), 'exports.CHANNEL = "x"\n')
  await writeFile(path.join(out, 'cli', 'index.js'), "require('./cli/run')\n")
  await writeFile(
    path.join(out, 'cli', 'cli', 'run.js'),
    "const client = require('../../main/daemon/client')\nexports.run = client.connect\n"
  )
  await writeFile(
    path.join(out, 'cli', 'cli', 'daemon', 'attach.js'),
    "exports.channel = require('../../../main/shared/ipc-contract').CHANNEL\n"
  )

  const sandbox = {
    root,
    out,
    script: path.join(scriptDir, GATE_SCRIPT),
    // Bare invocation = the advisory mode. package.json passes --strict, which is
    // exercised separately below; the require check gates in BOTH modes.
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage }),
    rejectsStrict: (violation, expectMessage) =>
      assertGateRejects({
        script: sandbox.script,
        args: ['--strict'],
        cwd: root,
        violation,
        expectMessage
      })
  }
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:build-output rejects an out/ whose halves are from different builds', () => {
  it('fails when a bundled main build replaced the tsc emit the CLI requires', async () => {
    const sandbox = await createSandbox()
    expect(sandbox.accepts()).toContain('artifacts are from the same build')

    // What `build:electron-vite` does: out/main becomes the bundle alone.
    await rm(path.join(sandbox.out, 'main', 'daemon'), { recursive: true })
    await rm(path.join(sandbox.out, 'main', 'shared'), { recursive: true })

    const output = sandbox.rejects(
      'out/main missing the tsc-emitted files out/cli requires',
      'the built CLI requires files that out/main no longer has'
    )
    expect(output).toContain(path.join('out', 'main', 'daemon', 'client'))
    expect(output).toContain('pnpm run build:cli')
  })

  it('fails on a cross-tree require nested below the top of out/cli', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    // Only the deep importer's target goes; a walk that stopped recursing sees nothing.
    await rm(path.join(sandbox.out, 'main', 'shared', 'ipc-contract.js'))

    const output = sandbox.rejects(
      'a missing require target reachable only from a nested out/cli file',
      'the built CLI requires files that out/main no longer has'
    )
    expect(output).toContain(path.join('out', 'cli', 'cli', 'daemon', 'attach.js'))
  })

  it('only warns about a stale CLI when run bare, which is the advisory mode', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    const stale = new Date(Date.now() - 90 * 60 * 1000)
    await utimes(path.join(sandbox.out, 'cli', 'index.js'), stale, stale)

    // Documents the advisory arm rather than pretending it gates: exit 0, message only.
    expect(sandbox.accepts()).toContain('out/ is inconsistent')
  })

  it('FAILS on a stale CLI under --strict, which is how package.json runs it', async () => {
    // The staleness check is the entire reason this script exists, and it used to
    // print its diagnosis and exit 0 because package.json omitted --strict. This
    // pins the arm that now gates.
    const sandbox = await createSandbox()
    sandbox.accepts()

    const stale = new Date(Date.now() - 90 * 60 * 1000)
    await utimes(path.join(sandbox.out, 'cli', 'index.js'), stale, stale)

    sandbox.rejectsStrict(
      'out/cli is 90 minutes staler than out/main',
      'out/ is inconsistent: out/main is newer than'
    )
  })
})
