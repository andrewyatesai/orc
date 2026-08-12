import { ipcMain } from 'electron'
import {
  getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache
} from '../ai-vault/cached-session-list'
import { deleteAiVaultSessionFile } from '../ai-vault/session-delete'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'

// Registers aiVault:deleteSession. The renderer calls it with
// { agent, filePath, executionHostId }; the executor owns re-validation and the
// trash, and this file invalidates the one shared scan cache on a real delete.
export function registerAiVaultDeleteHandler(): void {
  ipcMain.handle('aiVault:deleteSession', (_event, args?: AiVaultDeleteSessionArgs) =>
    deleteAiVaultSession(args)
  )
}

// Adapts the untyped IPC payload for the executor, then invalidates on a real
// delete — otherwise the shared cache keeps serving the deleted session for up
// to the scan TTL (desktop panel, runtime RPC, and paired mobile client alike).
export async function deleteAiVaultSession(
  args: AiVaultDeleteSessionArgs | undefined
): Promise<AiVaultDeleteSessionResult> {
  // The validator tolerates a malformed agent/filePath but destructures `args`,
  // so an absent payload is defaulted here to keep the never-throws boundary.
  const wslHomeDirs = await getAiVaultWslHomeDirs()
  const result = await deleteAiVaultSessionFile({
    agent: args?.agent as AiVaultAgent,
    sessionId: args?.sessionId,
    filePath: args?.filePath ?? '',
    executionHostId: args?.executionHostId,
    wslHomeDirs
  })

  if (result.outcome === 'deleted') {
    // The generation-guarded invalidation also stops an in-flight scan that
    // started before this delete from writing its pre-delete result back.
    invalidateAiVaultSessionListCache()
  }

  return result
}
