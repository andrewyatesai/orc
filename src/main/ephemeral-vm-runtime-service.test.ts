import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../shared/pairing-deep-link'
import { PAIRING_OFFER_VERSION } from '../shared/pairing'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import type { OrcaVmRecipe } from '../shared/types'

const tempDirs: string[] = []

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

describe('ephemeral VM runtime service', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: secure-file has dedicated ACL coverage; these tests focus on lifecycle semantics.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('persists a successful recipe-created runtime and cleans it up', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const cleanupPath = join(repoPath, 'cleanup.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo',",
        '  userData: { providerResourceId: process.env.ORCA_VM_INSTANCE_ID }',
        '}))'
      ].join('\n')
    )
    writeFileSync(
      cleanupPath,
      [
        "let input = ''",
        "process.stdin.on('data', (chunk) => { input += chunk })",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(input)',
        '  if (payload.recipeResult.projectRoot !== "/workspace/repo") process.exit(12)',
        '  if (!payload.recipeResult.userData.providerResourceId) process.exit(13)',
        '  console.error(`cleanup:${payload.instanceId}`)',
        '})'
      ].join('\n')
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      // Repo-owned recipes predate plugin bounds; snapshotting must not fail
      // after create has already provisioned external resources.
      description: 'x'.repeat(2_048),
      create: nodeCommand(startPath),
      destroy: nodeCommand(cleanupPath)
    }

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      repoId: 'repo-1',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      now: 1_000
    })

    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) {
      throw new Error(provisioned.start.error)
    }
    expect(provisioned.runtime).toMatchObject({
      id: provisioned.start.context.instanceId,
      recipeId: 'cloud-sandbox',
      recipe,
      repoId: 'repo-1',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1_000,
      updatedAt: 1_000
    })
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([provisioned.runtime])

    const cleanup = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: provisioned.runtime.id,
      now: 2_000
    })

    expect(cleanup).toMatchObject({
      ok: true,
      skipped: false,
      runtime: {
        id: provisioned.runtime.id,
        status: 'cleaned',
        cleanupStatus: 'succeeded',
        cleanupLastAttemptAt: 2_000
      }
    })
  })

  it('times out a hung destroy and starts a fresh retry', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const cleanupPath = join(repoPath, 'cleanup.js')
    const countPath = join(repoPath, 'cleanup-count.txt')
    writeFileSync(
      cleanupPath,
      `require('fs').appendFileSync(${JSON.stringify(countPath)}, 'x'); setInterval(() => {}, 1000)`
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: 'unused',
      destroy: nodeCommand(cleanupPath)
    }
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-1',
      recipeId: recipe.id,
      recipe,
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1_000,
      updatedAt: 1_000,
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    })
    const cleanupArgs = {
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1',
      destroyTimeoutMs: 100
    }

    await expect(cleanupEphemeralVmRuntime(cleanupArgs)).resolves.toMatchObject({
      ok: false,
      runtime: { status: 'cleanup_failed', cleanupStatus: 'failed' },
      error: expect.stringContaining('timed out')
    })
    writeFileSync(cleanupPath, `require('fs').appendFileSync(${JSON.stringify(countPath)}, 'x')`)
    await expect(
      cleanupEphemeralVmRuntime({ ...cleanupArgs, destroyTimeoutMs: 2_000 })
    ).resolves.toMatchObject({
      ok: true,
      runtime: { status: 'cleaned', cleanupStatus: 'succeeded' }
    })
    expect(readFileSync(countPath, 'utf8')).toBe('xx')
  })

  it('does not persist a runtime when recipe output cannot be parsed', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    writeFileSync(startPath, "console.log('not json')\n")

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: nodeCommand(startPath)
      }
    })

    expect(provisioned).toMatchObject({
      ok: false,
      start: {
        error: 'Recipe stdout must be one JSON object.'
      }
    })
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })
})
