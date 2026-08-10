// @proves-gate-fires check:native-provenance
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_MODULES = ['check-native-artifact-provenance.mjs', 'terminal-addon-source-stamp.mjs']
// The gate resolves the daemon by platform; the fixture has to name the same file.
const BIN_EXT = process.platform === 'win32' ? '.exe' : ''
// Well-formed enough for the stamp reader, and deliberately not this fixture's HEAD.
const FOREIGN_COMMIT = '0123456789abcdef0123456789abcdef01234567'
// package.json runs this gate twice: bare in `lint`, and `-- --require` in `build:release`.
const LINT_ARM = []
const RELEASE_ARM = ['--require']
const sandboxes = []

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=orca', '-c', 'user.email=orca@example.test', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

async function writeStamp(file, sourceCommit) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ schema: 1, sourceCommit }, null, 2)}\n`)
}

// A fake aterm submodule plus fake build outputs, stamped from the fixture's own HEAD so
// the real gate passes before anything is planted. Nothing here reads the real tree: the
// gate resolves every path from its own location, so a copy of it sees only the sandbox.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-native-provenance-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  const submodule = path.join(root, 'rust', 'aterm')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(submodule, 'src'), { recursive: true })
  await Promise.all(
    GATE_MODULES.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )

  await writeFile(path.join(submodule, 'Cargo.toml'), '[workspace.package]\nversion = "9.9.9"\n')
  await writeFile(path.join(submodule, 'src', 'lib.rs'), 'pub fn engine() {}\n')
  git(submodule, 'init', '--quiet')
  git(submodule, 'add', '-A')
  git(submodule, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture')
  const head = git(submodule, 'rev-parse', 'HEAD').trim()

  const addon = {
    binary: path.join(root, 'native', 'orca-node', 'orca_node.node'),
    stamp: path.join(root, 'native', 'orca-node', 'target', '.orca-installed-aterm-source.json')
  }
  const daemon = {
    binary: path.join(root, 'rust', 'target', 'release', `orca-daemon${BIN_EXT}`),
    stamp: path.join(root, 'rust', 'target', 'release', '.orca-daemon-aterm-source.json')
  }
  for (const artifact of [addon, daemon]) {
    await mkdir(path.dirname(artifact.binary), { recursive: true })
    await writeFile(artifact.binary, `\0fake native artifact built from aterm ${head}\n`)
    await writeStamp(artifact.stamp, head)
  }

  const script = path.join(scriptDir, GATE_MODULES[0])
  return {
    root,
    head,
    submodule,
    addon,
    daemon,
    accepts: (args = LINT_ARM) => assertGateAccepts({ script, args, cwd: root }),
    rejects: (violation, expectMessage, args = LINT_ARM) =>
      assertGateRejects({ script, args, cwd: root, violation, expectMessage })
  }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:native-provenance rejects unprovenanced native artifacts', () => {
  it('fails when an artifact stamp names a commit the submodule does not pin', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeStamp(sandbox.addon.stamp, FOREIGN_COMMIT)

    sandbox.rejects(
      'a provenance stamp that disagrees with the submodule',
      'orca_node.node was built from aterm'
    )
  })

  it('fails when the submodule moves and the artifacts keep their old provenance', async () => {
    const sandbox = await createSandbox()

    await writeFile(path.join(sandbox.submodule, 'src', 'lib.rs'), 'pub fn engine() { /* v2 */ }\n')
    git(sandbox.submodule, 'add', '-A')
    git(sandbox.submodule, 'commit', '--quiet', '--no-gpg-sign', '-m', 'move the engine')

    const output = sandbox.rejects(
      'a submodule bump with no native rebuild',
      'native artifacts do not match the aterm submodule pin'
    )
    // Both build outputs are stale, so neither may be reported as verified.
    expect(output).toContain('orca_node.node was built from aterm')
    expect(output).toContain(`orca-daemon${BIN_EXT} was built from aterm`)
  })

  it('fails when the submodule is not initialized at all', async () => {
    const sandbox = await createSandbox()

    await rm(path.join(sandbox.submodule, 'Cargo.toml'))

    sandbox.rejects('a missing aterm checkout', 'rust/aterm submodule is not initialized')
  })

  // The release arm is the one that refuses UNKNOWN provenance. The lint arm downgrades
  // the same state to a warning on purpose, so each case below pins both answers.
  it('fails the release arm when a shipped artifact carries no provenance at all', async () => {
    const sandbox = await createSandbox()

    await rm(sandbox.daemon.stamp)

    expect(sandbox.accepts()).toContain('carries no aterm source stamp')
    sandbox.rejects(
      'an unstamped build output',
      `orca-daemon${BIN_EXT} carries no aterm source stamp`,
      RELEASE_ARM
    )
  })

  it('fails the release arm when a bundled artifact is missing entirely', async () => {
    const sandbox = await createSandbox()

    await rm(sandbox.addon.binary)

    sandbox.accepts()
    sandbox.rejects('a missing native artifact', 'orca_node.node is missing', RELEASE_ARM)
  })

  it('fails the release arm when the submodule is dirty, so no stamp can be exact', async () => {
    const sandbox = await createSandbox()

    await writeFile(path.join(sandbox.submodule, 'src', 'lib.rs'), 'pub fn engine() { /* wip */ }\n')

    expect(sandbox.accepts()).toContain('rust/aterm checkout is not clean')
    sandbox.rejects(
      'an inexact provenance source',
      'native artifact provenance is not exact',
      RELEASE_ARM
    )
  })
})
