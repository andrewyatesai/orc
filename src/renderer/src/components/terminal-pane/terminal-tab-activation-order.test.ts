import { describe, expect, it } from 'vitest'
import { createTerminalTabActivationOrder } from './terminal-tab-activation-order'

describe('createTerminalTabActivationOrder', () => {
  it('stamps an increasing sequence in activation order', () => {
    const order = createTerminalTabActivationOrder()
    order.recordActiveTabId('tab-a')
    order.recordActiveTabId('tab-b')

    expect(order.getActivationSeq('tab-a')).toBe(0)
    expect(order.getActivationSeq('tab-b')).toBe(1)
    // Why: the later-activated tab outranks the earlier one for a same-pass tie.
    expect(order.getActivationSeq('tab-b')).toBeGreaterThan(order.getActivationSeq('tab-a') ?? -1)
  })

  it('does not bump the sequence when the same tab stays active across passes', () => {
    const order = createTerminalTabActivationOrder()
    order.recordActiveTabId('tab-a')
    order.recordActiveTabId('tab-a')

    expect(order.getActivationSeq('tab-a')).toBe(0)
  })

  it('re-stamps a re-activated tab with a fresh higher sequence after leaving the worktree', () => {
    const order = createTerminalTabActivationOrder()
    order.recordActiveTabId('tab-a')
    order.recordActiveTabId('tab-b')
    // Why: leaving the worktree records a null edge without stamping any tab.
    order.recordActiveTabId(null)
    order.recordActiveTabId('tab-a')

    expect(order.getActivationSeq('tab-a')).toBe(2)
    expect(order.getActivationSeq('tab-a')).toBeGreaterThan(order.getActivationSeq('tab-b') ?? -1)
  })

  it('drops sequences for tabs no longer live', () => {
    const order = createTerminalTabActivationOrder()
    order.recordActiveTabId('tab-a')
    order.recordActiveTabId('tab-b')
    order.retainTabIds(new Set(['tab-b']))

    expect(order.getActivationSeq('tab-a')).toBeUndefined()
    expect(order.getActivationSeq('tab-b')).toBe(1)
  })

  it('returns undefined for tabs never activated', () => {
    const order = createTerminalTabActivationOrder()
    order.recordActiveTabId('tab-a')

    expect(order.getActivationSeq('tab-never')).toBeUndefined()
  })
})
