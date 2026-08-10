// @proves-gate-fires check:quadratic-buffer-concat
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'check-quadratic-buffer-concat.mjs'
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const HEADLINE = 'Buffer.concat must not rebuild a loop-carried accumulator.'

// Both shapes the gate must accept: a per-iteration binding, and a single concat
// after the loop. Without this the fixture could be silently unscannable.
const CLEAN_SOURCE = `export function collect(chunks: Buffer[]): Buffer {
  const parts: Buffer[] = []
  for (const chunk of chunks) {
    let framed = Buffer.alloc(0)
    framed = Buffer.concat([framed, chunk])
    parts.push(framed)
  }
  return Buffer.concat(parts)
}
`

const sandboxes = []

// A fake repo the gate can walk: its own scan roots, a clean source file, and the
// node_modules the copied script resolves `typescript-api` through.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-quadratic-concat-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, 'src'), { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), path.join(scriptDir, GATE_SCRIPT))

  const modules = path.join(REPO_ROOT, 'node_modules')
  if (!existsSync(modules)) {
    throw new Error(`Sandbox needs ${modules} to resolve the gate's typescript-api import.`)
  }
  await symlink(modules, path.join(root, 'node_modules'), 'junction')
  await writeFile(path.join(root, 'src', 'stream-collector.ts'), CLEAN_SOURCE)

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_SCRIPT),
    plant: (relativePath, source) => writeFile(path.join(root, relativePath), source),
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:quadratic-buffer-concat rejects the O(n^2) accumulator it exists to catch', () => {
  it('fails when a loop assigns Buffer.concat back into its own operand', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plant(
      path.join('src', 'frame-assembler.ts'),
      `export function assemble(chunks: Buffer[]): Buffer {
  let accumulated = Buffer.alloc(0)
  for (const chunk of chunks) {
    accumulated = Buffer.concat([accumulated, chunk])
  }
  return accumulated
}
`
    )

    const output = sandbox.rejects(
      'a loop-carried accumulator rebuilt from itself',
      'src/frame-assembler.ts:4:19 accumulated — Buffer.concat([accumulated, chunk])'
    )
    expect(output).toContain(HEADLINE)
  })

  it('fails when the accumulator is a class field rebuilt in a while loop', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plant(
      path.join('src', 'pending-frame-buffer.ts'),
      `export class PendingFrameBuffer {
  private pending = Buffer.alloc(0)

  drain(chunks: Buffer[]): void {
    let index = 0
    while (index < chunks.length) {
      this.pending = Buffer.concat([this.pending, chunks[index]])
      index += 1
    }
  }
}
`
    )

    sandbox.rejects(
      'a class-field accumulator rebuilt from itself',
      'src/pending-frame-buffer.ts:7:22 this.pending — Buffer.concat([this.pending, chunks[index]])'
    )
  })

  it('fails when the concat result reaches the accumulator through a local alias', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    // No direct self-assignment: only the second analysis path (a loop-carried
    // operand reassigned elsewhere in the loop) can catch this.
    await sandbox.plant(
      path.join('src', 'relay-carry.ts'),
      `export function carry(chunks: Buffer[]): Buffer {
  let carried = Buffer.alloc(0)
  for (const chunk of chunks) {
    const merged = Buffer.concat([carried, chunk])
    carried = merged
  }
  return carried
}
`
    )

    sandbox.rejects(
      'an accumulator rebuilt through an alias',
      'carried — Buffer.concat([carried, chunk])'
    )
  })

  it('fails on a violation under any scan root, not just src', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await mkdir(path.join(sandbox.root, 'tools'), { recursive: true })
    await sandbox.plant(
      path.join('tools', 'transcript-packer.mjs'),
      `export function pack(chunks) {
  let packed = Buffer.alloc(0)
  for (let index = 0; index < chunks.length; index += 1) {
    packed = Buffer.concat([packed, chunks[index]])
  }
  return packed
}
`
    )

    sandbox.rejects(
      'a quadratic accumulator outside src',
      'tools/transcript-packer.mjs:4:14 packed — Buffer.concat([packed, chunks[index]])'
    )
  })
})

/**
 * One file per place the gate must reach, spelled out rather than derived from
 * SCAN_ROOTS: a root deleted from the gate has to fail a case here, and a list read
 * back out of the gate would shrink along with it.
 */
const COVERED_LOCATIONS = [
  'src/main/pty-stream-carry.ts',
  'build-plugins/renderer-chunk-budget.ts',
  'electron.vite.config.ts',
  'config/vitest-warning-filter.ts',
  'config/scripts/verify-linux-glibc-floor.cjs',
  'tools/repro-stream-carry.mjs',
  'tests/e2e/fixtures/stream-carry-fixture.cjs',
  'mobile/src/stream-carry.ts',
  '.github/scripts/render-readme-downloads-badge.mjs'
]

// Line 4, column 15 holds the concat, so the reported position is part of the assertion.
const LOCATION_VIOLATION = `function collect(chunks) {
  let carried = Buffer.alloc(0)
  for (const chunk of chunks) {
    carried = Buffer.concat([carried, chunk])
  }
  return carried
}
`

describe('check:quadratic-buffer-concat reaches every tree location it claims to scan', () => {
  for (const file of COVERED_LOCATIONS) {
    it(`rejects a loop-carried accumulator in ${file}`, async () => {
      const sandbox = await createSandbox()
      const target = path.join(sandbox.root, ...file.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      sandbox.accepts()

      await sandbox.plant(path.join(...file.split('/')), LOCATION_VIOLATION)

      sandbox.rejects(
        `a quadratic accumulator in ${file}`,
        `${file}:4:15 carried — Buffer.concat([carried, chunk])`
      )
    })
  }
})
