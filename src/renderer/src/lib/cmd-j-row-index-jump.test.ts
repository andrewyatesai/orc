import { describe, expect, it } from 'vitest'
import { emitCmdJRowIndexJump, subscribeCmdJRowIndexJump } from './cmd-j-row-index-jump'

describe('cmd-j-row-index-jump', () => {
  it('delivers the emitted index to every subscriber', () => {
    const seen: number[] = []
    const unsubscribe = subscribeCmdJRowIndexJump((index) => seen.push(index))

    emitCmdJRowIndexJump(3)
    unsubscribe()

    expect(seen).toEqual([3])
  })

  it('stops delivering row jumps after unsubscribe', () => {
    const seen: number[] = []
    const unsubscribe = subscribeCmdJRowIndexJump((index) => seen.push(index))

    emitCmdJRowIndexJump(0)
    unsubscribe()
    emitCmdJRowIndexJump(1)

    expect(seen).toEqual([0])
  })
})
