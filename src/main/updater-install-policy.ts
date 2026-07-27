export type UpdateInstallMode = 'automatic' | 'manual' | 'bundle-swap'

export function getUpdateInstallMode(
  platform: NodeJS.Platform = process.platform
): UpdateInstallMode {
  // Why: Squirrel.Mac refuses an update whose code signature does not match the running
  // app, so it cannot serve an ad-hoc-signed build at all. Swapping the .app ourselves
  // (updater-bundle-swap.ts) makes signing a distribution concern, not an update one.
  if (platform === 'darwin') {
    return 'bundle-swap'
  }
  // Why: Windows has no stable ALab publisher identity for NSIS to authenticate against,
  // and Linux spans four package topologies (writable AppImage, root-owned AppImage, deb,
  // rpm) that need different apply paths. Both stay manual until each is built.
  return 'manual'
}

/**
 * Whether this mode resolves the target release itself instead of letting
 * electron-updater's provider decide. True for every mode except `automatic`.
 */
export function usesSelfManagedCheck(mode: UpdateInstallMode): boolean {
  return mode !== 'automatic'
}
