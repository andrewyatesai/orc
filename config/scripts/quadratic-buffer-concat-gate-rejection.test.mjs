// @proves-gate-fires check:quadratic-buffer-concat
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = path.join(import.meta.dirname, 'check-quadratic-buffer-concat.mjs')
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

const CLEAN = `function joinChunks(chunks) {
  const parts = []
  for (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}
module.exports = { joinChunks }
`
// Line 3 holds the concat, so the report's line number is part of the assertion.
const QUADRATIC = `function joinChunks(chunks) {
  let carry = Buffer.alloc(0)
  for (const chunk of chunks) carry = Buffer.concat([carry, chunk])
  return carry
}
module.exports = { joinChunks }
`

/**
 * One tracked file per place the gate must reach, spelled out rather than derived
 * from SCAN_ROOTS: a root deleted from the gate has to fail a case here, and a list
 * read back from the gate would shrink with it.
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

const sandboxes = []

async function plant(file, source) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-quadratic-gate-')))
  sandboxes.push(root)
  const target = path.join(root, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, source)
  return root
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:quadratic-buffer-concat sees every tree location it claims to scan', () => {
  it('passes on the real repository tree', () => {
    assertGateAccepts({ script: GATE_SCRIPT, cwd: REPO_ROOT })
  })

  for (const file of COVERED_LOCATIONS) {
    it(`rejects a loop-carried accumulator in ${file}`, async () => {
      // Positive control first: the same path with the chunk-list fix must pass, so a
      // rejection below is the planted violation and not a broken fixture tree.
      assertGateAccepts({ script: GATE_SCRIPT, cwd: await plant(file, CLEAN) })

      assertGateRejects({
        script: GATE_SCRIPT,
        cwd: await plant(file, QUADRATIC),
        violation: `an accumulator rebuilt by Buffer.concat in ${file}`,
        expectMessage: `${file}:3:`
      })
    })
  }
})
