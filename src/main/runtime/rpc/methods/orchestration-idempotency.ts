import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'

// Why a client-supplied key, not ctx.requestId: ctx.requestId is a per-FRAME
// correlation id that changes on every retry/reconnect, so it cannot survive the
// reconnect it must dedupe. The mutating RPC schemas take an optional
// `idempotencyKey`; when the client supplies one, a retry replays the recorded
// result instead of applying the mutation twice.

export type MutationIdempotency = {
  callerFingerprint: string
  requestId: string
  method: string
  /** The operation inputs; hashed to detect a reused key with changed input. */
  payload: unknown
}

/** Stable SHA-256 over the canonicalized payload — compared only against itself
 *  (a later attempt under the same key), never against the Rust digest, so
 *  node:crypto is sufficient and no shared hash contract is needed. */
export function mutationPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

// Sorted keys so a semantically-identical payload hashes identically regardless
// of property order across a retry.
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, sortKeysDeep(source[key])])
    )
  }
  return value
}

type PaneKeyResolver = { getTerminalPaneKey(handle: string): string | null | undefined }

/** A durable caller identity for the receipt PK: the caller's pane key survives a
 *  handle remint; the raw handle is the fallback; anonymous when neither exists. */
export function orchestrationCallerFingerprint(
  runtime: PaneKeyResolver,
  handle: string | undefined
): string {
  if (!handle) {
    return 'orchestration:anonymous'
  }
  const paneKey = runtime.getTerminalPaneKey(handle)
  return paneKey ? `pane:${paneKey}` : `handle:${handle}`
}

/**
 * Wrap a mutating handler body with the durable idempotency ledger. When
 * `idempotency` is undefined (the client supplied no key) the body runs as-is,
 * so every existing caller is unaffected. Otherwise a duplicate request replays
 * the stored result WITHOUT re-executing, a concurrent duplicate is rejected
 * (`mutation_in_progress`), and a failure discards the slot so the caller may
 * retry cleanly.
 */
export async function withMutationReceipt<T>(
  db: OrchestrationDb,
  idempotency: MutationIdempotency | undefined,
  execute: () => Promise<T> | T
): Promise<T> {
  if (!idempotency) {
    return execute()
  }
  const key = {
    callerFingerprint: idempotency.callerFingerprint,
    requestId: idempotency.requestId,
    method: idempotency.method,
    payloadHash: mutationPayloadHash(idempotency.payload)
  }
  const claim = db.mutationReceipts.begin(key)
  if (claim.disposition === 'completed') {
    return JSON.parse(claim.row.receipt ?? 'null') as T
  }
  if (claim.disposition === 'pending') {
    // A prior attempt under this key still holds the slot (a concurrent request
    // in flight, or a crash between begin and complete). Rejecting avoids a
    // double-apply; the caller retries once the first settles and then replays.
    throw new OrchestrationError(
      'mutation_in_progress',
      `Mutation request ${idempotency.requestId} is already in progress.`
    )
  }
  try {
    const result = await execute()
    db.mutationReceipts.complete(key, JSON.stringify(result ?? null))
    return result
  } catch (error) {
    db.mutationReceipts.discardPending(idempotency.callerFingerprint, idempotency.requestId)
    throw error
  }
}
