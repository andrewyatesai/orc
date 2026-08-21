import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

const scanAiVaultSessions = vi.fn<() => Promise<AiVaultListResult>>()

vi.mock('./session-scanner', () => ({
  scanAiVaultSessions: (...args: unknown[]) => scanAiVaultSessions(...(args as [])),
  DEFAULT_AI_VAULT_LIMIT: 200
}))

function result(sessionIds: string[]): AiVaultListResult {
  return {
    sessions: sessionIds.map((id) => ({ sessionId: id })) as AiVaultListResult['sessions'],
    issues: [],
    scannedAt: new Date().toISOString()
  } as AiVaultListResult
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('cached-session-list invalidation generation guard', () => {
  beforeEach(async () => {
    scanAiVaultSessions.mockReset()
    const mod = await import('./cached-session-list')
    mod.resetAiVaultSessionListCacheForTests()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('serves the cached list within the TTL, then drops it after invalidation', async () => {
    const { listAiVaultSessions, invalidateAiVaultSessionListCache } =
      await import('./cached-session-list')
    scanAiVaultSessions.mockResolvedValueOnce(result(['a', 'b']))

    const first = await listAiVaultSessions()
    expect(first.sessions.map((s) => s.sessionId)).toEqual(['a', 'b'])
    // Second call is served from cache (no second scan).
    await listAiVaultSessions()
    expect(scanAiVaultSessions).toHaveBeenCalledTimes(1)

    invalidateAiVaultSessionListCache()
    scanAiVaultSessions.mockResolvedValueOnce(result(['b']))
    const afterDelete = await listAiVaultSessions()
    expect(afterDelete.sessions.map((s) => s.sessionId)).toEqual(['b'])
    expect(scanAiVaultSessions).toHaveBeenCalledTimes(2)
  })

  it('does not let an in-flight pre-delete scan write its stale result back into the cache', async () => {
    const { listAiVaultSessions, invalidateAiVaultSessionListCache } =
      await import('./cached-session-list')
    const pending = deferred<AiVaultListResult>()
    scanAiVaultSessions.mockReturnValueOnce(pending.promise)

    // A scan is in flight (carries the pre-delete generation).
    const inflight = listAiVaultSessions()
    // A delete lands and invalidates while that scan is still running.
    invalidateAiVaultSessionListCache()
    // The scan now resolves with the stale (pre-delete) session set.
    pending.resolve(result(['a', 'deleted']))
    await inflight

    // The next read must re-scan rather than serve the stale write.
    scanAiVaultSessions.mockResolvedValueOnce(result(['a']))
    const next = await listAiVaultSessions()
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['a'])
    expect(scanAiVaultSessions).toHaveBeenCalledTimes(2)
  })
})
