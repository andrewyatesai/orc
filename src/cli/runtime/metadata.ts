import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import {
  findTransport,
  getRuntimeMetadataPath,
  type RuntimeMetadata
} from '../../shared/runtime-bootstrap'
import { userDataProfileCandidates } from '../../shared/user-data-profile'
import { RuntimeClientError } from './types'

export function readMetadata(userDataPath: string): RuntimeMetadata {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
    if (!metadata || !findTransport(metadata, 'unix', 'named-pipe') || !metadata.authToken) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        `Orca runtime metadata is incomplete at ${metadataPath}`
      )
    }
    return metadata
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    throw new RuntimeClientError(
      'runtime_unavailable',
      `Could not read Orca runtime metadata at ${metadataPath}. Start the Orca app first.`
    )
  }
}

export function tryReadMetadata(userDataPath: string): RuntimeMetadata | null {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
  } catch {
    return null
  }
}

export function getDefaultUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  // Why: in dev mode (and for parallel Orca instances), the Electron app writes
  // runtime metadata to a separate userData directory (e.g. `orca-dev`) to avoid
  // clobbering the production app's metadata. The CLI needs to find the same
  // metadata file, so this env var lets the CLI target a specific instance.
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  // Why: the CLI must find the same metadata file Electron writes in packaged
  // runs, so this mirrors Electron's default userData base instead of inventing
  // a CLI-specific config path. Fork builds inject productName, which moves that
  // base to 'Orca ALab Edition' — resolving only the public 'orca' name made
  // every CLI command report a not_running runtime against a packaged ALab app.
  const candidates = userDataProfileCandidates(platform, homeDir, process.env)
  if (candidates.length === 0) {
    throw new RuntimeClientError(
      'runtime_unavailable',
      'APPDATA is not set, so the Orca runtime metadata path cannot be resolved.'
    )
  }
  // Why: prefer whichever installed edition actually left runtime metadata behind,
  // so a machine carrying both editions targets the one that has run.
  return (
    candidates.find((candidate) => existsSync(getRuntimeMetadataPath(candidate))) ?? candidates[0]
  )
}
