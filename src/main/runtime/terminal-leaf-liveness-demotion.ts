import { parseAppSshPtyId } from '../../shared/ssh-pty-id'

const REMOTE_PTY_ID_PREFIX = 'remote:'

/**
 * A leaf's `connected`/`writable` mirror the renderer graph (`ptyId !== null`),
 * so a restored surface whose PTY died with a prior run reads connected forever.
 * Demote only on a *proof of absence*, never a proof of liveness:
 *
 * - the aggregate controller inventory must authoritatively omit the ptyId
 *   (`null` inventory is unknown liveness — it proves nothing and demotes nothing);
 * - the id must be locally scoped — SSH/remote inventories live on another host
 *   and may legitimately not cover it;
 * - the provider must not synchronously still know the id, closing the
 *   spawn/list race where a just-spawned PTY registers after the snapshot (one
 *   `connected: false` reads as exited to federation).
 */
export function isLeafPtyProvenAbsent(args: {
  ptyId: string | null
  provenLivePtyIds: ReadonlySet<string> | null
  controllerHasPty: (ptyId: string) => boolean | null
}): boolean {
  const { ptyId, provenLivePtyIds, controllerHasPty } = args
  return (
    provenLivePtyIds !== null &&
    ptyId !== null &&
    !provenLivePtyIds.has(ptyId) &&
    !ptyId.startsWith(REMOTE_PTY_ID_PREFIX) &&
    parseAppSshPtyId(ptyId) === null &&
    controllerHasPty(ptyId) !== true
  )
}
