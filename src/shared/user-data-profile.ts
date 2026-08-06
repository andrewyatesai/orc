import { join } from 'node:path'

/**
 * The userData directory names Electron derives from the packaged app's name.
 *
 * Why: electron-builder injects `productName` into the packaged package.json for
 * fork builds (config/electron-builder.config.cjs), so Electron's app.getName()
 * — and therefore userData — becomes 'Orca ALab Edition'. Public-identity builds
 * omit that injection and fall back to the package `name`, 'orca'. Anything that
 * has to find a running app's profile from outside the app (the CLI) must agree
 * with that derivation or it looks in a directory the app never writes to.
 */
export const ALAB_PROFILE_DIR_NAME = 'Orca ALab Edition'
export const PUBLIC_IDENTITY_PROFILE_DIR_NAME = 'orca'

export type UserDataProfileEnv = {
  APPDATA?: string | undefined
  XDG_CONFIG_HOME?: string | undefined
}

function profileBase(
  platform: NodeJS.Platform,
  homeDir: string,
  env: UserDataProfileEnv
): string | null {
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support')
  }
  if (platform === 'win32') {
    return env.APPDATA ?? null
  }
  return env.XDG_CONFIG_HOME || join(homeDir, '.config')
}

/**
 * Candidate userData directories for a locally installed Orca, most specific first.
 *
 * Why: this checkout builds the ALab edition by default, but a machine can carry
 * both editions at once, so the CLI probes rather than assuming one. Order is the
 * tiebreak when both profiles exist but only one is running.
 */
export function userDataProfileCandidates(
  platform: NodeJS.Platform,
  homeDir: string,
  env: UserDataProfileEnv
): string[] {
  const base = profileBase(platform, homeDir, env)
  if (!base) {
    return []
  }
  return [join(base, ALAB_PROFILE_DIR_NAME), join(base, PUBLIC_IDENTITY_PROFILE_DIR_NAME)]
}
