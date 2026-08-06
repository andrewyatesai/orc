import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import {
  ALAB_PROFILE_DIR_NAME,
  PUBLIC_IDENTITY_PROFILE_DIR_NAME,
  userDataProfileCandidates
} from '../../shared/user-data-profile'
import { getDefaultUserDataPath } from './metadata'

/**
 * Why: electron-builder injects productName for fork builds, so a packaged ALab
 * app writes userData to 'Orca ALab Edition'. The CLI resolved only the public
 * 'orca' name, so every command reported a not_running runtime against a live
 * app. These tests plant a real profile on disk and resolve through the CLI's own
 * production entry point.
 */
describe('CLI userData profile resolution', () => {
  let home: string

  const plantMetadata = (profileDirName: string) => {
    const profile = join(home, 'Library', 'Application Support', profileDirName)
    mkdirSync(profile, { recursive: true })
    writeFileSync(getRuntimeMetadataPath(profile), JSON.stringify({ authToken: 'token' }))
    return profile
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-profile-'))
    delete process.env.ORCA_USER_DATA_PATH
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('finds the packaged ALab profile the app actually writes', () => {
    const profile = plantMetadata(ALAB_PROFILE_DIR_NAME)
    expect(getDefaultUserDataPath('darwin', home)).toBe(profile)
  })

  it('still finds a public-identity build that uses the package name', () => {
    const profile = plantMetadata(PUBLIC_IDENTITY_PROFILE_DIR_NAME)
    expect(getDefaultUserDataPath('darwin', home)).toBe(profile)
  })

  it('prefers the ALab profile when both editions have run on one machine', () => {
    const alab = plantMetadata(ALAB_PROFILE_DIR_NAME)
    plantMetadata(PUBLIC_IDENTITY_PROFILE_DIR_NAME)
    expect(getDefaultUserDataPath('darwin', home)).toBe(alab)
  })

  it('falls back to the ALab profile when no app has run yet', () => {
    expect(getDefaultUserDataPath('darwin', home)).toBe(
      join(home, 'Library', 'Application Support', ALAB_PROFILE_DIR_NAME)
    )
  })

  it('lets ORCA_USER_DATA_PATH override the probe for dev and parallel instances', () => {
    plantMetadata(ALAB_PROFILE_DIR_NAME)
    process.env.ORCA_USER_DATA_PATH = '/tmp/orca-dev-profile'
    try {
      expect(getDefaultUserDataPath('darwin', home)).toBe('/tmp/orca-dev-profile')
    } finally {
      delete process.env.ORCA_USER_DATA_PATH
    }
  })

  it('builds per-platform candidates from Electron userData bases', () => {
    expect(userDataProfileCandidates('darwin', '/home/me', {})).toEqual([
      `/home/me/Library/Application Support/${ALAB_PROFILE_DIR_NAME}`,
      `/home/me/Library/Application Support/${PUBLIC_IDENTITY_PROFILE_DIR_NAME}`
    ])
    expect(userDataProfileCandidates('win32', '/home/me', { APPDATA: 'C:\\AppData' })).toEqual([
      join('C:\\AppData', ALAB_PROFILE_DIR_NAME),
      join('C:\\AppData', PUBLIC_IDENTITY_PROFILE_DIR_NAME)
    ])
    expect(userDataProfileCandidates('linux', '/home/me', {})).toEqual([
      `/home/me/.config/${ALAB_PROFILE_DIR_NAME}`,
      `/home/me/.config/${PUBLIC_IDENTITY_PROFILE_DIR_NAME}`
    ])
    // Why: Windows without APPDATA has no derivable base; the caller must raise
    // rather than silently probing a wrong directory.
    expect(userDataProfileCandidates('win32', '/home/me', {})).toEqual([])
  })
})
