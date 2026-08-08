import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

const PANE_A = 'tab1:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c'
const PANE_A_REMINTED = 'tab9:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c'
const PANE_B = 'tab1:1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d'

// Shim-contract pins for the v10 capability surface, mirroring the reference
// branch's db-shim-contract.test.ts: dcap_ shape, store-side minting, hash-only
// persistence, and coded errors surviving napi.
describe('dispatch capability shim contract', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  function seed(paneKey?: string): { taskId: string; dispatchId: string } {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'do the thing' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', paneKey)
    return { taskId: task.id, dispatchId: dispatch.id }
  }

  function mint(dispatchId: string, incarnation = 'pty_1:inc_1'): string {
    return db!.capabilities.mint({
      dispatchId,
      paneKey: PANE_A,
      processIncarnation: incarnation
    })
  }

  it('mints dcap_<43 base64url chars> store-side, fresh every call', () => {
    const state = seed(PANE_A)
    const first = mint(state.dispatchId)
    const second = mint(state.dispatchId)
    for (const token of [first, second]) {
      expect(token).toMatch(/^dcap_[A-Za-z0-9_-]{43}$/)
    }
    expect(first).not.toBe(second)
  })

  it('persists only the node:crypto sha256 hex of the token, never the token', () => {
    const state = seed(PANE_A)
    const token = mint(state.dispatchId)
    const row = db!.getDispatchContextById(state.dispatchId)!
    // Cross-implementation pin: the Rust store's hand-rolled SHA-256 must agree
    // with createHash('sha256') byte-for-byte, or verify would never match.
    expect(row.capability_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(row.process_incarnation).toBe('pty_1:inc_1')
    expect(row.capability_revoked_at).toBeNull()
    expect(row.contract_version).toBe(1)
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('verifies the roundtrip, surviving a pane remint', () => {
    const state = seed(PANE_A)
    const token = mint(state.dispatchId)
    expect(
      db!.capabilities.verify({
        dispatchId: state.dispatchId,
        capability: token,
        paneKey: PANE_A,
        processIncarnation: 'pty_1:inc_1'
      })
    ).toEqual({ valid: true })
    expect(
      db!.capabilities.verify({
        dispatchId: state.dispatchId,
        capability: token,
        paneKey: PANE_A_REMINTED,
        processIncarnation: 'pty_1:inc_1'
      })
    ).toEqual({ valid: true })
  })

  it('refuses a wrong token, a wrong pane, a stale incarnation, and revocation', () => {
    const state = seed(PANE_A)
    const token = mint(state.dispatchId)

    const base = {
      dispatchId: state.dispatchId,
      capability: token,
      paneKey: PANE_A,
      processIncarnation: 'pty_1:inc_1'
    }
    expect(db!.capabilities.verify({ ...base, capability: 'dcap_wrong' })).toEqual({
      valid: false,
      reason: 'The Dispatch capability is invalid.'
    })
    expect(db!.capabilities.verify({ ...base, paneKey: PANE_B })).toEqual({
      valid: false,
      reason: 'The caller is not the Dispatch pane.'
    })
    expect(db!.capabilities.verify({ ...base, processIncarnation: 'pty_1:inc_2' })).toEqual({
      valid: false,
      reason: 'The Dispatch process incarnation changed.'
    })
    expect(db!.capabilities.verify({ ...base, capability: undefined })).toEqual({
      valid: false,
      reason: 'The Dispatch capability is missing.'
    })

    db!.capabilities.revoke(state.dispatchId)
    expect(db!.capabilities.verify(base)).toEqual({
      valid: false,
      reason: `Dispatch ${state.dispatchId} capability is revoked.`
    })
    // The hash is kept after revocation so the presentation stays diagnosable.
    expect(db!.getDispatchContextById(state.dispatchId)!.capability_hash).not.toBeNull()
  })

  it('completing or failing the dispatch revokes a minted capability', () => {
    const state = seed(PANE_A)
    const token = mint(state.dispatchId)
    db!.completeDispatch(state.dispatchId)
    expect(
      db!.capabilities.verify({
        dispatchId: state.dispatchId,
        capability: token,
        paneKey: PANE_A,
        processIncarnation: 'pty_1:inc_1'
      })
    ).toEqual({ valid: false, reason: `Dispatch ${state.dispatchId} capability is revoked.` })

    // Legacy rows (never minted) stay byte-identical: no revocation stamp.
    const legacyTask = db!.createTask({ spec: 'legacy' })
    const legacy = db!.createDispatchContext(legacyTask.id, 'term_other')
    db!.completeDispatch(legacy.id)
    expect(db!.getDispatchContextById(legacy.id)!.capability_revoked_at).toBeNull()
  })

  it('rethrows coded store failures as OrchestrationError across napi', () => {
    const state = seed(PANE_A)
    db!.completeDispatch(state.dispatchId)

    let thrown: unknown
    try {
      mint(state.dispatchId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OrchestrationError)
    expect((thrown as OrchestrationError).code).toBe('dispatch_inactive')
    expect((thrown as OrchestrationError).message).toBe(
      `Dispatch ${state.dispatchId} is not active.`
    )
    expect((thrown as OrchestrationError).message).not.toContain('_orcaOrchestrationError')

    expect(() => db!.capabilities.commitLaunchTokenHash('ctx_missing', 'h')).toThrowError(
      expect.objectContaining({ code: 'dispatch_not_found' })
    )
  })

  it('commits the launch token first-write-wins with a coded mismatch', () => {
    const state = seed(PANE_A)
    const committed = db!.capabilities.commitLaunchTokenHash(state.dispatchId, 'hash-1')
    expect(committed.launch_token_hash).toBe('hash-1')
    expect(db!.capabilities.commitLaunchTokenHash(state.dispatchId, 'hash-1').launch_token_hash).toBe(
      'hash-1'
    )
    expect(() => db!.capabilities.commitLaunchTokenHash(state.dispatchId, 'hash-2')).toThrowError(
      expect.objectContaining({ code: 'request_mismatch' })
    )
  })

  it('reports process currency without consuming a capability', () => {
    const state = seed(PANE_A)
    mint(state.dispatchId)
    const current = (paneKey: string | null, processIncarnation: string | null): boolean =>
      db!.capabilities.isProcessCurrent({
        dispatchId: state.dispatchId,
        paneKey,
        processIncarnation
      })
    expect(current(PANE_A, 'pty_1:inc_1')).toBe(true)
    expect(current(PANE_A_REMINTED, 'pty_1:inc_1')).toBe(true)
    expect(current(PANE_B, 'pty_1:inc_1')).toBe(false)
    expect(current(PANE_A, 'pty_1:inc_2')).toBe(false)
    expect(current(null, 'pty_1:inc_1')).toBe(false)
    expect(current(PANE_A, null)).toBe(false)
  })

  it('stamps dispatch_capability_invalid rejections that survive re-reads', () => {
    seed(PANE_A)
    const msg = db!.insertMessage({
      from: 'term_worker',
      to: 'term_coord',
      subject: 'done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: 't', dispatchId: 'd' })
    })
    const rewritten = db!.convertLifecycleMessageToRejection(
      msg.id,
      'The Dispatch capability is invalid.',
      'dispatch_capability_invalid'
    )!
    const payload = JSON.parse(rewritten.payload!) as {
      _orcaLifecycleRejection: { code: string; reason: string }
    }
    expect(payload._orcaLifecycleRejection.code).toBe('dispatch_capability_invalid')
    expect(payload._orcaLifecycleRejection.reason).toBe('The Dispatch capability is invalid.')
  })
})
