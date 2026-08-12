import { describe, expect, it } from 'vitest'
import { createSshPortHydrationBarrier } from './ssh-port-hydration-barrier'

describe('createSshPortHydrationBarrier', () => {
  it('applies a snapshot when no push arrived during the fetch', () => {
    const barrier = createSshPortHydrationBarrier()
    const ticket = barrier.begin('target-a')
    expect(ticket.shouldApplyForwards()).toBe(true)
    expect(ticket.shouldApplyDetected()).toBe(true)
  })

  it('suppresses only the stream whose push landed mid-fetch', () => {
    const barrier = createSshPortHydrationBarrier()
    const ticket = barrier.begin('target-a')
    barrier.noteForwardPush('target-a')
    expect(ticket.shouldApplyForwards()).toBe(false)
    expect(ticket.shouldApplyDetected()).toBe(true)
  })

  it('ignores pushes for targets with no pending hydration', () => {
    const barrier = createSshPortHydrationBarrier()
    barrier.noteForwardPush('target-a')
    barrier.noteDetectedPush('target-a')
    // A subsequent hydration begins with a clean slate.
    const ticket = barrier.begin('target-a')
    expect(ticket.shouldApplyForwards()).toBe(true)
    expect(ticket.shouldApplyDetected()).toBe(true)
  })

  it('isolates pending state per target', () => {
    const barrier = createSshPortHydrationBarrier()
    const first = barrier.begin('target-a')
    const second = barrier.begin('target-b')
    barrier.noteDetectedPush('target-b')
    expect(first.shouldApplyDetected()).toBe(true)
    expect(second.shouldApplyDetected()).toBe(false)
  })

  it('does not clobber a re-entrant hydration when the prior ticket finishes', () => {
    const barrier = createSshPortHydrationBarrier()
    const first = barrier.begin('target-a')
    const second = barrier.begin('target-a')
    // A push for the live (second) hydration must survive the stale ticket's finish.
    barrier.noteForwardPush('target-a')
    first.finish()
    expect(second.shouldApplyForwards()).toBe(false)
  })
})
