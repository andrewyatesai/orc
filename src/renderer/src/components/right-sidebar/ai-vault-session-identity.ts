import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { areCatalogValuesEqual } from '@/store/slices/catalog-value-equality'
import { reconcileCatalogRows } from '@/store/slices/repo-identity-reconcile'

// Stable empty reference so a null scan derives the same sessions array each render.
export const EMPTY_AI_VAULT_SESSIONS: AiVaultSession[] = []

// Why: listSessions structured-clones nested rows (previewMessages, subagent), and a
// host-cache TTL miss remints scannedAt even when disk contents did not change. The panel
// only skipped apply on scannedAt equality, so alt-tab after the TTL rebuilt sessionProjectById
// and the worktree path map for every row. Reuse previous row + result identity when the payload
// is structurally unchanged so those memos stay cold. Reference compare is inert — IPC clones never match.
export function reuseAiVaultListResult(
  current: AiVaultListResult | null,
  incoming: AiVaultListResult
): AiVaultListResult {
  if (current === incoming) {
    return current
  }
  if (!current) {
    return incoming
  }
  const sessions = reconcileCatalogRows(
    current.sessions,
    incoming.sessions,
    (session) => session.id
  )
  const issues = areCatalogValuesEqual(current.issues, incoming.issues)
    ? current.issues
    : incoming.issues
  if (sessions === current.sessions && issues === current.issues) {
    return current
  }
  if (sessions === incoming.sessions && issues === incoming.issues) {
    return incoming
  }
  return { ...incoming, sessions, issues }
}

export function applyPublishedAiVaultList(
  published: AiVaultListResult,
  setScanResult: (updater: (prev: AiVaultListResult | null) => AiVaultListResult) => void
): void {
  setScanResult((prev) => reuseAiVaultListResult(prev, published))
}
