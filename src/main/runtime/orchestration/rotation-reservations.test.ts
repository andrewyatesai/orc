import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const MINUTE = 60_000

describe('rotation-saga reservations (schema v9)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('claims a target, minting the saga id and the first fence', () => {
    const d = createDb()
    const claim = d.rotations.claim({
      provider: 'claude',
      targetRouteKey: 'claude|managed:acct-b|local',
      targetStoreKey: 'darwin|~/.claude-b',
      sourceRouteKey: 'claude|managed:acct-a|local',
      ttlMs: 5 * MINUTE
    })

    expect(claim.outcome).toBe('claimed')
    if (claim.outcome !== 'claimed') {
      return
    }
    expect(claim.saga.id).toMatch(/^saga_/)
    expect(claim.saga.phase).toBe('planned')
    expect(claim.saga.reservation_fence).toBe(1)
    expect(claim.saga.reservation_released_at).toBeNull()
    expect(claim.saga.last_error).toBeNull()
    expect(claim.saga.source_route_key).toBe('claude|managed:acct-a|local')
    expect(claim.swept_expired).toBe(0)
  })

  it('gives two sagas racing one successor exactly one winner, and names the holder', () => {
    const d = createDb()
    const target = { provider: 'claude', targetRouteKey: 'claude|managed:acct-b|local' }
    const winner = d.rotations.claim({ ...target, ttlMs: 5 * MINUTE })
    const loser = d.rotations.claim({ ...target, ttlMs: 5 * MINUTE })

    expect(winner.outcome).toBe('claimed')
    expect(loser.outcome).toBe('conflict')
    if (loser.outcome !== 'conflict' || winner.outcome !== 'claimed') {
      return
    }
    expect(loser.holder.id).toBe(winner.saga.id)
    expect(d.rotations.listLive('claude').map((s) => s.id)).toEqual([winner.saga.id])
  })

  it('conflicts on an overlapping store key even when the route differs', () => {
    const d = createDb()
    const shared = 'darwin|~/.claude+keychain'
    d.rotations.claim({
      provider: 'claude',
      targetRouteKey: 'claude|system-default|local',
      targetStoreKey: shared,
      ttlMs: 5 * MINUTE
    })
    const second = d.rotations.claim({
      provider: 'claude',
      targetRouteKey: 'claude|managed:acct-c|local',
      targetStoreKey: shared,
      ttlMs: 5 * MINUTE
    })

    // A rotation is a multi-key transaction (§3a): two different routes writing
    // one credential surface is exactly the store-mixing §8.2a forbids.
    expect(second.outcome).toBe('conflict')
  })

  it('leaves store-key-less claims independent — NULLs never collide', () => {
    const d = createDb()
    const a = d.rotations.claim({
      provider: 'codex',
      targetRouteKey: 'codex|managed:acct-a|local',
      ttlMs: MINUTE
    })
    const b = d.rotations.claim({
      provider: 'codex',
      targetRouteKey: 'codex|managed:acct-b|local',
      ttlMs: MINUTE
    })
    expect(a.outcome).toBe('claimed')
    expect(b.outcome).toBe('claimed')
  })

  it('sweeps an expired reservation on the next claim and bumps the fence', () => {
    const d = createDb()
    const stale = d.rotations.claim({
      provider: 'claude',
      targetRouteKey: 'claude|managed:acct-b|local',
      ttlMs: -MINUTE
    })
    expect(stale.outcome).toBe('claimed')

    const next = d.rotations.claim({
      provider: 'claude',
      targetRouteKey: 'claude|managed:acct-b|local',
      ttlMs: 5 * MINUTE
    })

    expect(next.outcome).toBe('claimed')
    if (next.outcome !== 'claimed' || stale.outcome !== 'claimed') {
      return
    }
    // The expired row had to be transactionally marked released for the partial
    // unique index to lift — elapsed time alone does not lapse a constraint.
    expect(next.swept_expired).toBe(1)
    expect(d.rotations.get(stale.saga.id)?.reservation_released_at).not.toBeNull()
    expect(next.saga.reservation_fence).toBe(stale.saga.reservation_fence + 1)
  })

  it('fences release, renew and phase advance against a saga that lost the claim', () => {
    const d = createDb()
    const claim = d.rotations.claim({
      provider: 'claude',
      targetRouteKey: 'claude|managed:acct-b|local',
      ttlMs: 5 * MINUTE
    })
    if (claim.outcome !== 'claimed') {
      throw new Error('expected the first claim to succeed')
    }
    const { id, reservation_fence: fence } = claim.saga

    expect(d.rotations.renew(id, fence - 1, 5 * MINUTE)).toBe(false)
    expect(d.rotations.advancePhase(id, fence - 1, 'target-prepared')).toBeUndefined()
    expect(d.rotations.release(id, fence - 1)).toBe(false)

    expect(d.rotations.renew(id, fence, 10 * MINUTE)).toBe(true)
    expect(d.rotations.advancePhase(id, fence, 'target-prepared')?.phase).toBe('target-prepared')
    expect(
      d.rotations.advancePhase(id, fence, 'needs-human', 'distro unavailable')?.last_error
    ).toBe('distro unavailable')
    expect(d.rotations.release(id, fence)).toBe(true)
    // Released is terminal for the reservation: a second release changes nothing.
    expect(d.rotations.release(id, fence)).toBe(false)
    expect(d.rotations.listLive()).toEqual([])
  })

  it('frees the target once the holder releases', () => {
    const d = createDb()
    const target = { provider: 'claude', targetRouteKey: 'claude|managed:acct-b|local' }
    const first = d.rotations.claim({ ...target, ttlMs: 5 * MINUTE })
    if (first.outcome !== 'claimed') {
      throw new Error('expected the first claim to succeed')
    }
    d.rotations.release(first.saga.id, first.saga.reservation_fence)

    const second = d.rotations.claim({ ...target, ttlMs: 5 * MINUTE })
    expect(second.outcome).toBe('claimed')
    if (second.outcome !== 'claimed') {
      return
    }
    expect(second.saga.reservation_fence).toBe(first.saga.reservation_fence + 1)
  })
})
