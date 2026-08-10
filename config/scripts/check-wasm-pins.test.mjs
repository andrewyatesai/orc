// @proves-gate-fires check:wasm-pins
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'
import { WASM_CRATE_PINS } from './wasm-crate-artifact-pin.mjs'

const GATE_MODULES = ['check-orca-wasm-pins.mjs', 'wasm-crate-artifact-pin.mjs']
const CRATES = Object.keys(WASM_CRATE_PINS)
const sandboxes = []

const abs = (root, rel) => path.join(root, ...rel.split('/'))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fakeWasm(crate, payload) {
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from(`${crate}:${payload}`)
  ])
}

function base64Module(bytes) {
  // Shape decodeBase64Module needs: the first single-quoted base64 literal in the file.
  return `// GENERATED fixture.\nexport const WASM_BASE64 =\n  '${bytes.toString('base64')}'\n`
}

// Mirrors crateSourceSha256: sorted per directory, `<rel>\0<bytes>\0` folded in walk order.
async function crateSourceSha256(sourceAbs) {
  const hash = createHash('sha256')
  const walk = async (dir) => {
    for (const name of (await readdir(dir)).sort()) {
      const child = path.join(dir, name)
      if ((await stat(child)).isDirectory()) {
        await walk(child)
        continue
      }
      hash.update(`${path.relative(sourceAbs, child).split(path.sep).join('/')}\0`)
      hash.update(await readFile(child))
      hash.update('\0')
    }
  }
  await walk(sourceAbs)
  return hash.digest('hex')
}

// Pin derived from the bytes on disk, so a clean fixture passes the real gate and
// every failure below is the planted violation rather than a hand-typed hash.
async function writePin(root, crate) {
  const descriptor = WASM_CRATE_PINS[crate]
  const artifacts = {}
  for (const rel of descriptor.artifacts) {
    const bytes = await readFile(abs(root, rel))
    artifacts[rel] = { bytes: bytes.byteLength, sha256: sha256(bytes) }
  }
  const pin = {
    schema: 1,
    crate: descriptor.label,
    sourceSha256: await crateSourceSha256(abs(root, descriptor.sourceDir)),
    wasmSha256: sha256(await readFile(abs(root, descriptor.rawWasm))),
    artifacts
  }
  await writeFile(abs(root, descriptor.pinPath), `${JSON.stringify(pin, null, 2)}\n`)
}

async function materializeCrate(root, crate) {
  const descriptor = WASM_CRATE_PINS[crate]
  const sourceAbs = abs(root, descriptor.sourceDir)
  await mkdir(path.join(sourceAbs, 'src'), { recursive: true })
  await writeFile(path.join(sourceAbs, 'Cargo.toml'), `[package]\nname = "${descriptor.label}"\n`)
  await writeFile(path.join(sourceAbs, 'src', 'lib.rs'), `pub fn ${crate}_entry() {}\n`)

  const wasm = fakeWasm(crate, 'first build')
  for (const rel of [...descriptor.artifacts, descriptor.pinPath]) {
    await mkdir(path.dirname(abs(root, rel)), { recursive: true })
  }
  for (const rel of descriptor.artifacts) {
    if (rel === descriptor.base64Module) {
      await writeFile(abs(root, rel), base64Module(wasm))
    } else if (rel.endsWith('_bg.wasm')) {
      await writeFile(abs(root, rel), wasm)
    } else {
      await writeFile(abs(root, rel), `// ${rel} generated from ${descriptor.label}\n`)
    }
  }
  await writePin(root, crate)
}

async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-wasm-pin-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await Promise.all(
    GATE_MODULES.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )
  for (const crate of CRATES) {
    await materializeCrate(root, crate)
  }

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_MODULES[0]),
    file: (rel) => abs(root, rel),
    repin: (crate) => writePin(root, crate),
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:wasm-pins rejects artifacts that disagree with their pin', () => {
  it('fails when a committed wasm byte changes without repinning', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    const { rawWasm } = WASM_CRATE_PINS.crypto
    const bytes = await readFile(sandbox.file(rawWasm))
    bytes[bytes.byteLength - 1] ^= 0xff // same length: only the hash can catch this
    await writeFile(sandbox.file(rawWasm), bytes)

    sandbox.rejects('a mutated wasm byte', `${rawWasm} does not match its size/SHA-256 pin`)
  })

  it('fails when the pinned SHA-256 is edited to a value the bytes do not produce', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    const descriptor = WASM_CRATE_PINS.git
    const pinPath = sandbox.file(descriptor.pinPath)
    const pin = JSON.parse(await readFile(pinPath, 'utf8'))
    const target = descriptor.artifacts.find((rel) => rel.endsWith('.js'))
    pin.artifacts[target].sha256 = 'f'.repeat(64)
    await writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`)

    sandbox.rejects('a hand-edited pin hash', `${target} does not match its size/SHA-256 pin`)
  })

  it('fails when the crate source is edited without a rebuild', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    const { sourceDir } = WASM_CRATE_PINS.git
    await writeFile(sandbox.file(`${sourceDir}/src/lib.rs`), 'pub fn git_entry() { /* new */ }\n')

    sandbox.rejects(
      'a source edit with no rebuild',
      'source changed since the artifacts were built'
    )
  })

  it('fails when the base64 module and the renderer wasm are different builds', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    // Repinned, so the half-regenerated pair is the only thing left to notice.
    const descriptor = WASM_CRATE_PINS.crypto
    const rebuilt = base64Module(fakeWasm('crypto', 'rebuilt'))
    await writeFile(sandbox.file(descriptor.base64Module), rebuilt)
    await sandbox.repin('crypto')

    sandbox.rejects(
      'a base64 module from another build',
      `${descriptor.base64Module} decodes to bytes that differ from ${descriptor.rawWasm}`
    )
  })

  it('fails when a committed artifact is deleted', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    const target = WASM_CRATE_PINS.crypto.artifacts.find((rel) => rel.endsWith('.d.ts'))
    await rm(sandbox.file(target))

    sandbox.rejects('a deleted committed artifact', `committed artifact missing: ${target}`)
  })
})
