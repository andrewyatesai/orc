import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { sessionSortTime } from './session-scanner-accumulator'

export function aiVaultScanIssueResult(args: {
  executionHostId?: ExecutionHostId
  path: string
  message: string
}): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        ...(args.executionHostId ? { executionHostId: args.executionHostId } : {}),
        agent: 'codex',
        path: args.path,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

// Why: the serving-side scan is host-local and cached once for every caller
// (desktop parent, web, mobile), so callers that address this host by a runtime
// id get the cached result restamped on the way out instead of a per-host scan.
// Mirrors the scanner's stamp recipe so ids stay stable across both paths.
export function restampAiVaultListResult(
  result: AiVaultListResult,
  executionHostId: ExecutionHostId
): AiVaultListResult {
  return {
    sessions: result.sessions.map((session) =>
      session.executionHostId === executionHostId
        ? session
        : {
            ...session,
            executionHostId,
            id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
          }
    ),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: result.scannedAt
  }
}

export function mergeAiVaultListResults(
  results: readonly AiVaultListResult[],
  rawLimit: number | undefined
): AiVaultListResult {
  const limit = rawLimit && rawLimit > 0 ? Math.floor(rawLimit) : 1000
  const byId = new Map<string, AiVaultSession>()
  const issues: AiVaultScanIssue[] = []
  for (const result of results) {
    for (const session of result.sessions) {
      byId.set(session.id, session)
    }
    issues.push(...result.issues)
  }
  return {
    sessions: [...byId.values()]
      .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
      .slice(0, limit),
    issues,
    // Why: a merge is not a new scan. Reminting here made every all-host cache
    // hit look fresh to the renderer, which only skipped apply when scannedAt
    // matched. Keep the latest input stamp so identical legs stay a no-op.
    scannedAt: latestAiVaultScannedAt(results)
  }
}

function latestAiVaultScannedAt(results: readonly AiVaultListResult[]): string {
  const now = new Date().toISOString()
  let latest: string | undefined
  for (const result of results) {
    const stamp = result.scannedAt
    // Remote legs carry their own clock and only `z.string()` validation. An
    // unparsable or future stamp would pin the merged stamp above every local
    // rescan and silently freeze the renderer's scannedAt equality guard.
    if (Number.isNaN(Date.parse(stamp)) || stamp > now) {
      continue
    }
    if (latest === undefined || stamp > latest) {
      latest = stamp
    }
  }
  return latest ?? now
}

/**
 * Failure-result constructors for the three scan sources. They live beside
 * `aiVaultScanIssueResult` rather than in the IPC module because they are the same
 * kind of thing it is — a scan that could not run, expressed as an empty result
 * carrying its reason — and the IPC file's job is registering handlers.
 */
export function runtimeScanIssueResult(
  executionHostId: ExecutionHostId,
  environmentId: string,
  message: string
): AiVaultListResult {
  return aiVaultScanIssueResult({ executionHostId, path: environmentId, message })
}

/** Discovery itself failed, so no host can be named. */
export function runtimeHostDiscoveryIssueResult(message: string): AiVaultListResult {
  return aiVaultScanIssueResult({ path: 'runtime environments', message })
}

export function sshScanIssueResult(args: {
  executionHostId: `ssh:${string}`
  targetId: string
  message: string
}): AiVaultListResult {
  return aiVaultScanIssueResult({
    executionHostId: args.executionHostId,
    path: args.targetId,
    message: args.message
  })
}
