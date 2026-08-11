import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import type { MutationReceiptKey } from './mutation-receipts'

// Shim-contract pins for the v11 mutation-receipt surface: the disposition
// marshals across napi, the stored receipt survives a round trip, and coded
// store failures restore to OrchestrationError so callers branch on `.code`.
describe('mutation receipt shim contract', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const CALLER = 'pane:tab1:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c'
  function key(over: Partial<MutationReceiptKey> = {}): MutationReceiptKey {
    return {
      callerFingerprint: CALLER,
      requestId: 'req-1',
      method: 'orchestration.dispatch',
      payloadHash: 'hash-1',
      ...over
    }
  }

  function codeOf(call: () => unknown): string {
    try {
      call()
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      return (error as OrchestrationError).code
    }
    throw new Error('expected the call to throw')
  }

  it('claims, reports pending on retry, then replays the stored receipt', () => {
    db = new OrchestrationDb(':memory:')
    const store = db.mutationReceipts

    const started = store.begin(key())
    expect(started.disposition).toBe('started')
    expect(started.row.state).toBe('pending')
    expect(started.row.method).toBe('orchestration.dispatch')
    expect(started.row.receipt).toBeNull()

    // A retry while the mutation is in flight is 'pending', not a second claim.
    expect(store.begin(key()).disposition).toBe('pending')

    const stored = '{"dispatch":{"id":"ctx_1"},"injected":true}'
    const completed = store.complete(key(), stored)
    expect(completed.state).toBe('completed')
    expect(completed.receipt).toBe(stored)

    const replay = store.begin(key())
    expect(replay.disposition).toBe('completed')
    expect(replay.row.receipt).toBe(stored)
  })

  it('rejects a reused key with changed input as a coded request_mismatch', () => {
    db = new OrchestrationDb(':memory:')
    const store = db.mutationReceipts
    store.begin(key())

    expect(codeOf(() => store.begin(key({ payloadHash: 'hash-2' })))).toBe('request_mismatch')
    expect(codeOf(() => store.begin(key({ method: 'orchestration.taskCreate' })))).toBe(
      'request_mismatch'
    )
    // The rolled-back rejections left the original claim intact.
    expect(store.get(CALLER, 'req-1')?.payload_hash).toBe('hash-1')
  })

  it('complete requires the matching method and payload', () => {
    db = new OrchestrationDb(':memory:')
    const store = db.mutationReceipts
    store.begin(key())
    expect(codeOf(() => store.complete(key({ payloadHash: 'hash-2' }), '{}'))).toBe(
      'request_mismatch'
    )
    // The failed complete left the slot pending and unrecorded.
    expect(store.get(CALLER, 'req-1')?.state).toBe('pending')
  })

  it('discardPending frees a pending slot but never a completed one', () => {
    db = new OrchestrationDb(':memory:')
    const store = db.mutationReceipts
    store.begin(key())
    store.discardPending(CALLER, 'req-1')
    expect(store.get(CALLER, 'req-1')).toBeUndefined()

    // The freed slot is reclaimable, even with different input.
    expect(store.begin(key({ payloadHash: 'hash-9' })).disposition).toBe('started')
    store.complete(key({ payloadHash: 'hash-9' }), '{}')
    store.discardPending(CALLER, 'req-1')
    expect(store.get(CALLER, 'req-1')?.state).toBe('completed')
  })

  it('get returns undefined for an unknown key', () => {
    db = new OrchestrationDb(':memory:')
    const store = db.mutationReceipts
    store.begin(key())
    expect(store.get('pane:other', 'req-1')).toBeUndefined()
    expect(store.get(CALLER, 'req-2')).toBeUndefined()
  })
})
