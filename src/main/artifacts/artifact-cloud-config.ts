import { app } from 'electron'

// The upstream public artifact host. A fork must never default to it: it is a
// vendor service this build does not own, so shipping a signed-in account's
// bearer token there would leak a credential. Only a packaged public-identity
// build (mirroring getOrcaCloudAuthConfig) may inherit it.
const PUBLIC_ARTIFACTS_API_URL = 'https://share.onorca.dev'

export const ARTIFACT_CLOUD_UNCONFIGURED_MESSAGE =
  'Artifact sharing is not configured for this build. Set ORCA_ARTIFACTS_API_URL to your Orca cloud artifact host.'

function isPackaged(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

function isPackagedPublicBuild(): boolean {
  try {
    return app?.isPackaged === true && app?.name === 'Orca'
  } catch {
    return false
  }
}

/**
 * Resolves the artifact API origin, or `null` when this build has no first-party
 * host configured. The caller surfaces `null` as a coded "not configured" state
 * rather than defaulting fork traffic to the upstream vendor. An explicitly
 * configured `ORCA_ARTIFACTS_API_URL` (or `--api-url` override) is operator
 * intent, trusted the same way getOrcaCloudAuthConfig trusts `ORCA_CLOUD_API_URL`.
 */
export function resolveArtifactCloudApiUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged(),
  publicIdentity = isPackagedPublicBuild()
): string | null {
  const configured = override?.trim() || env.ORCA_ARTIFACTS_API_URL?.trim()
  const candidate = configured || (packaged && publicIdentity ? PUBLIC_ARTIFACTS_API_URL : null)
  if (!candidate) {
    return null
  }
  const url = new URL(candidate)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !packaged)) {
    throw new Error('Artifact API URLs must use HTTPS; local development may use loopback HTTP.')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Artifact API URL must be an origin without credentials, paths, or parameters.')
  }
  return url.origin
}

export function allowsArtifactCloudAuthOverride(
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged()
): boolean {
  return env.NODE_ENV !== 'production' && !packaged
}
