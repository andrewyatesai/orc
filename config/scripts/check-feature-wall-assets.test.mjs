// @proves-gate-fires check:feature-wall-assets
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_MODULE = 'check-feature-wall-assets.mjs'
const ASSET_DIR = path.join('resources', 'onboarding', 'feature-wall')
const MEDIA_TILE_IDS = Array.from(
  { length: 12 },
  (_, index) => `tile-${String(index + 1).padStart(2, '0')}`
)
const OVER_BUDGET_BYTES = 12 * 1024 * 1024
const sandboxes = []

// The gate resolves its asset dir from its own location, not cwd, so the copied script
// plus a fake resources/ tree is the whole world it can see.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-feature-wall-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  const assetDir = path.join(root, ASSET_DIR)
  await mkdir(scriptDir, { recursive: true })
  await mkdir(assetDir, { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_MODULE), path.join(scriptDir, GATE_MODULE))

  await Promise.all(
    MEDIA_TILE_IDS.flatMap((id) => [
      writeFile(path.join(assetDir, `${id}.gif`), `GIF89a ${id}\n`),
      writeFile(path.join(assetDir, `${id}.poster.jpg`), `\xff\xd8\xff ${id}\n`),
      writeFile(
        path.join(assetDir, `${id}.recorded-at.json`),
        `${JSON.stringify({ recordedAt: '2026-01-01T00:00:00.000Z', tile: id })}\n`
      )
    ])
  )

  const sandbox = {
    root,
    assetDir,
    asset: (name) => path.join(assetDir, name),
    script: path.join(scriptDir, GATE_MODULE),
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:feature-wall-assets rejects the shipped media going missing', () => {
  it('fails when a referenced recording is deleted', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await rm(sandbox.asset('tile-07.gif'))

    sandbox.rejects('a deleted tile recording', 'Feature wall assets are missing: tile-07.gif')
  })

  it('fails when a poster is renamed out from under the expected filename', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await rename(sandbox.asset('tile-03.poster.jpg'), sandbox.asset('tile-03.poster.jpeg'))

    sandbox.rejects(
      'a poster renamed to an unreferenced extension',
      'Feature wall assets are missing: tile-03.poster.jpg'
    )
  })

  it('fails when the asset directory is emptied rather than shipped', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    // The case the gate's own comment calls out: a byte-budget-only check passes here.
    await rm(sandbox.assetDir, { recursive: true, force: true })

    sandbox.rejects(
      'an empty feature wall asset directory',
      'Feature wall assets are missing: tile-01.gif, tile-01.poster.jpg'
    )
  })

  it('fails when an unoptimized recording blows the installer budget', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(sandbox.asset('tile-05.gif'), Buffer.alloc(OVER_BUDGET_BYTES))

    sandbox.rejects(
      'a tile recording larger than the whole budget',
      'which exceeds the 11.00 MB installer budget'
    )
  })
})
