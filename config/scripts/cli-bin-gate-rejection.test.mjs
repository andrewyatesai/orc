// @proves-gate-fires verify:cli-bin
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'verify-cli-bin.mjs'
const BIN_TARGET = './out/cli/index.js'
const OUT_BOUNDARY = path.join('out', 'package.json')
const CLI_SOURCE = '#!/usr/bin/env node\nif (process.argv.includes("--help")) process.exit(0)\n'
const sandboxes = []

/**
 * `out/cli` only exists after `build:cli`, so the gate's own baseline is red on a clean
 * checkout. Every input it reads is built here instead, and the real tree is never touched.
 */
async function createSandbox() {
  // realpath: the gate only runs `main()` when argv[1] matches its resolved module URL,
  // and /var -> /private/var would make a spawn of it exit 0 without checking anything.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-cli-bin-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  const script = path.join(scriptDir, GATE_SCRIPT)
  const binPath = path.join(root, 'out', 'cli', 'index.js')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.dirname(binPath), { recursive: true })
  // Same depth as the shipped copy: the gate resolves projectDir two levels above itself.
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), script)

  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      { name: 'orca-cli-bin-fixture', private: true, type: 'module', bin: { orca: BIN_TARGET } },
      null,
      2
    )}\n`
  )
  await writeFile(
    path.join(root, OUT_BOUNDARY),
    `${JSON.stringify({ name: 'orca-compiled-output', type: 'commonjs', private: true }, null, 2)}\n`
  )
  await writeFile(binPath, CLI_SOURCE)
  await chmod(binPath, 0o755)

  return {
    root,
    binPath,
    packageJsonPath: path.join(root, 'package.json'),
    boundaryPath: path.join(root, OUT_BOUNDARY),
    // package.json runs `node config/scripts/verify-cli-bin.mjs` from the repo root, no flags.
    accepts: () => assertGateAccepts({ script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script, cwd: root, violation, expectMessage })
  }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verify:cli-bin rejects a published CLI entrypoint it is supposed to catch', () => {
  it('fails when the compiled entrypoint lost its Node shebang', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(sandbox.binPath, 'require("./main")\n')

    sandbox.rejects(
      'a bin target with no shebang',
      `bin.orca target must start with a Node shebang: ${BIN_TARGET}`
    )
  })

  it('fails when the compiled entrypoint is emitted empty', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(sandbox.binPath, '')

    sandbox.rejects('an empty bin target', `bin.orca target is empty: ${BIN_TARGET}`)
  })

  it('fails when the compiled CommonJS boundary is missing', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await rm(sandbox.boundaryPath)

    sandbox.rejects(
      'a compiled tree with no package boundary',
      `compiled CLI package boundary is missing: ${OUT_BOUNDARY}`
    )
  })

  it('fails when the compiled boundary declares ESM instead of CommonJS', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(sandbox.boundaryPath, `${JSON.stringify({ type: 'module' })}\n`)

    sandbox.rejects(
      'a boundary that inherits the root type=module',
      `compiled CLI package boundary must declare type=commonjs: ${OUT_BOUNDARY}`
    )
  })

  it('fails when package.json stops declaring the orca bin', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(
      sandbox.packageJsonPath,
      `${JSON.stringify({ name: 'orca-cli-bin-fixture', private: true, bin: {} }, null, 2)}\n`
    )

    sandbox.rejects('a package.json with no bin.orca', 'package.json must declare bin.orca')
  })

  it.skipIf(process.platform === 'win32')(
    'fails when the compiled entrypoint lost its executable bit',
    async () => {
      const sandbox = await createSandbox()
      sandbox.accepts()

      await chmod(sandbox.binPath, 0o644)

      sandbox.rejects(
        'a bin target with no POSIX executable bit',
        `bin.orca target is not executable: ${BIN_TARGET}`
      )
    }
  )
})
