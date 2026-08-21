import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { ARTIFACT_SHARING_DISABLED_CODE } from '../../shared/artifact-sharing-gate'
import { ARTIFACT_CLOUD_UNCONFIGURED_MESSAGE } from './artifact-cloud-config'
import { ArtifactCloudService } from './artifact-cloud-service'

const createdPaths: string[] = []

async function userDataPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-artifact-service-'))
  createdPaths.push(path)
  return path
}

const writeRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Hi</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html'
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('ArtifactCloudService offline guard', () => {
  it('reports the coded unconfigured state without any network call when no host is configured', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the offline guard must not reach the network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const service = new ArtifactCloudService(await userDataPath(), () => true)

    await expect(service.list({})).resolves.toEqual({
      status: 'unconfigured',
      message: ARTIFACT_CLOUD_UNCONFIGURED_MESSAGE
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports unconfigured when a host resolves but the cloud account is not configured', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the offline guard must not reach the network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const service = new ArtifactCloudService(await userDataPath(), () => true)

    // A loopback host resolves, so the profile + auth-config path runs, but a
    // fresh local profile has no cloud session — it must fail closed, not POST.
    const result = await service.list({ apiUrl: 'http://127.0.0.1:53999' })

    expect(result.status).toBe('unconfigured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a publish before touching the network when sharing is disabled', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the sharing gate must not reach the network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const service = new ArtifactCloudService(await userDataPath(), () => false)

    await expect(service.share(writeRequest)).rejects.toMatchObject({
      code: ARTIFACT_SHARING_DISABLED_CODE
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
