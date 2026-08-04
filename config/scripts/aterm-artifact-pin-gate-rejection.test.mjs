// @proves-gate-fires check:aterm-pin
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_MODULES = [
  'check-aterm-artifact-pin.mjs',
  'aterm-wasm-source-patch.mjs',
  'wasm-build-paths.mjs'
]
const PATCH_PATH = path.join('config', 'patches', 'aterm-wasm-source-fixes.patch')
const ENGINE_VERSION = '9.9.9'
const WASM_ARTIFACTS = [
  'aterm_wasm.js',
  'aterm_wasm.d.ts',
  'aterm_wasm_bg.wasm',
  'aterm_wasm_bg.wasm.d.ts',
  'aterm_gpu_web.js',
  'aterm_gpu_web.d.ts',
  'aterm_gpu_web_bg.wasm',
  'aterm_gpu_web_bg.wasm.d.ts'
]
const sandboxes = []

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=orca', '-c', 'user.email=orca@example.test', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

function identity(bytes) {
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// A fake submodule plus fake artifacts, wired so the real gate passes: the pin the
// gate reads is derived from the bytes on disk rather than asserted alongside them.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-aterm-pin-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  const submodule = path.join(root, 'rust', 'aterm')
  const wasmDir = path.join(root, 'src', 'renderer', 'src', 'lib', 'pane-manager', 'aterm')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(submodule, 'src'), { recursive: true })
  await mkdir(path.join(root, 'config', 'patches'), { recursive: true })
  await mkdir(wasmDir, { recursive: true })
  await Promise.all(
    GATE_MODULES.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )

  await writeFile(
    path.join(submodule, 'Cargo.toml'),
    `[workspace.package]\nversion = "${ENGINE_VERSION}"\n`
  )
  await writeFile(path.join(submodule, 'src', 'lib.rs'), 'pub fn engine() {}\n')
  git(submodule, 'init', '--quiet')
  git(submodule, 'add', '-A')
  git(submodule, 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture')

  // Generate the downstream fix with Git so `git apply --check` provably accepts it.
  await writeFile(path.join(submodule, 'src', 'lib.rs'), 'pub fn engine() { /* wasm fix */ }\n')
  await writeFile(path.join(root, PATCH_PATH), git(submodule, 'diff'))
  git(submodule, 'checkout', '--', '.')

  await Promise.all(
    WASM_ARTIFACTS.map((name) =>
      writeFile(path.join(wasmDir, name), `${name} built by aterm(${ENGINE_VERSION})\n`)
    )
  )
  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_MODULES[0]),
    artifact: (name) => path.join(wasmDir, name),
    patch: path.join(root, PATCH_PATH),
    submodule,
    repin: () => writePin(root, wasmDir),
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  await sandbox.repin()
  return sandbox
}

async function writePin(root, wasmDir) {
  const artifacts = Object.fromEntries(
    await Promise.all(
      WASM_ARTIFACTS.map(async (name) => [name, identity(await readFile(path.join(wasmDir, name)))])
    )
  )
  const pin = {
    schema: 2,
    sourceCommit: git(path.join(root, 'rust', 'aterm'), 'rev-parse', 'HEAD').trim(),
    sourcePatch: {
      path: PATCH_PATH.split(path.sep).join('/'),
      sha256: identity(await readFile(path.join(root, PATCH_PATH))).sha256
    },
    artifacts
  }
  await writeFile(
    path.join(wasmDir, 'aterm_wasm_artifact_pin.json'),
    `${JSON.stringify(pin, null, 2)}\n`
  )
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:aterm-pin rejects drift it is supposed to catch', () => {
  it('fails when a committed artifact is rebuilt without repinning', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(sandbox.artifact('aterm_wasm.d.ts'), 'stale glue from an older build\n')

    sandbox.rejects('an artifact that no longer matches its pin', 'does not match its exact')
  })

  it('fails when the submodule moves without a wasm rebuild', async () => {
    const sandbox = await createSandbox()

    await writeFile(path.join(sandbox.submodule, 'README.md'), 'engine moved on\n')
    git(sandbox.submodule, 'add', '-A')
    git(sandbox.submodule, 'commit', '--quiet', '--no-gpg-sign', '-m', 'move the engine')

    sandbox.rejects('a submodule bump with no rebuild', 'artifact manifest pins')
  })

  it('fails when the engine version and the shipped marker disagree', async () => {
    const sandbox = await createSandbox()

    await writeFile(
      path.join(sandbox.submodule, 'Cargo.toml'),
      '[workspace.package]\nversion = "9.9.10"\n'
    )

    sandbox.rejects('a version bump with no rebuild', 'but the submodule pin is 9.9.10')
  })

  it('fails when a shipped wasm blob embeds the builder filesystem', async () => {
    const sandbox = await createSandbox()

    // Repinned, so the leak is the only thing left for the gate to notice.
    // Linux-form home on purpose: containsLocalCargoSourcePath treats /home and /Users
    // identically, and a literal /Users/<name> here trips the publication export's
    // central forbidden-content baseline, which no repository policy can suppress.
    await writeFile(
      sandbox.artifact('aterm_wasm_bg.wasm'),
      `\0asm aterm(${ENGINE_VERSION})\0/home/builder/.cargo/registry/src/engine.rs\0`
    )
    await sandbox.repin()

    sandbox.rejects('a leaked local build path', 'embeds a local Cargo source path')
  })

  it('fails when the downstream source patch is edited without repinning', async () => {
    const sandbox = await createSandbox()

    await writeFile(sandbox.patch, `${await readFile(sandbox.patch, 'utf8')}\n`)

    sandbox.rejects('an edited source patch', 'source patch does not match its exact SHA-256 pin')
  })
})
