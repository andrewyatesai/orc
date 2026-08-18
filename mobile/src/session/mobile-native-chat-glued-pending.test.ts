import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { GLUE_SLIDE_BUDGET, selectGluedPendingIds } from './mobile-native-chat-glued-pending'

type GluedPending = {
  id: string
  text: string
  images?: string[]
  baselineTailMessageId: string | null
}

function userTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function assistantTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

/** A send captured with `tail` as the last transcript message it could see. */
function pendingSend(id: string, text: string, tail: string | null): GluedPending {
  return { id, text, baselineTailMessageId: tail }
}

function retiredIds(
  messages: readonly NativeChatMessage[],
  pending: readonly GluedPending[]
): string[] {
  return [...selectGluedPendingIds(messages, pending)].sort()
}

describe('selectGluedPendingIds', () => {
  it('retires both bubbles when two rapid sends collapse into one user row', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests again', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('retires a glued row that concatenated with no separator at all', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the testsagain', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('retires three collapsed prompts in one row', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two three', 5000)]
    const pending = [
      pendingSend('p1', 'one', 'm1'),
      pendingSend('p2', 'two', 'm1'),
      pendingSend('p3', 'three', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2', 'p3'])
  })

  it('matches across tab, newline and repeated-space separators', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests\t\n  again', 5000)
    ]
    const pending = [
      pendingSend('p1', ' run the tests\n', 'm1'),
      pendingSend('p2', '\tagain ', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches prompts that themselves contain the separator', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'fix the bug and run the tests', 5000)
    ]
    const pending = [
      pendingSend('p1', 'fix the bug', 'm1'),
      pendingSend('p2', 'and run the tests', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches when one pending is a strict prefix of the next', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'run run the tests', 5000)]
    const pending = [pendingSend('p1', 'run', 'm1'), pendingSend('p2', 'run the tests', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches identical prompts sent twice and three times', () => {
    const twice = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'hi hi', 5000)]
    expect(retiredIds(twice, [pendingSend('p1', 'hi', 'm1'), pendingSend('p2', 'hi', 'm1')])).toEqual(
      ['p1', 'p2']
    )

    const thrice = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'hi hi hi', 5000)]
    expect(
      retiredIds(thrice, [
        pendingSend('p1', 'hi', 'm1'),
        pendingSend('p2', 'hi', 'm1'),
        pendingSend('p3', 'hi', 'm1')
      ])
    ).toEqual(['p1', 'p2', 'p3'])
  })

  it('retires two separate glued rows against their own runs', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'one two', 5000),
      userTurn('m3', 'three four', 6000)
    ]
    const pending = [
      pendingSend('p1', 'one', 'm1'),
      pendingSend('p2', 'two', 'm1'),
      pendingSend('p3', 'three', 'm2'),
      pendingSend('p4', 'four', 'm2')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  // FP1: the concatenation already exists in history, older than the sends.
  it('never lets a transcript row that predates the sends retire them', () => {
    const messages = [
      userTurn('m1', 'run the tests again', 1),
      assistantTurn('m2', 'done', 2),
      assistantTurn('m3', 'anything else?', 3)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm3'), pendingSend('p2', 'again', 'm3')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  // FP2: an old turn reads like the concatenation of two much later sends.
  it('never lets an older turn retire sends captured after it', () => {
    const messages = [userTurn('m1', 'fix the bug', 1000), assistantTurn('m2', 'fixed', 1100)]
    const pending = [pendingSend('p1', 'fix the', 'm2'), pendingSend('p2', 'bug', 'm2')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects a row the pending run only prefixes', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests again with coverage', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects a lone exact match, which is an ordinary landing, not glue', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'run the tests', 5000)]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects glue when a send in the run cannot resolve its own tail', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [pendingSend('p1', 'one', 'm1'), pendingSend('p2', 'two', 'paginated-away')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('treats a null tail as "transcript was empty", so any row can glue', () => {
    const messages = [userTurn('m1', 'one two', 5000)]
    const pending = [pendingSend('p1', 'one', null), pendingSend('p2', 'two', null)]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  // A head that can never match must not freeze the run behind it: one stuck
  // bubble would otherwise disable glue retirement for the rest of the session.
  it('glues a later pair even when the head of the run can never match', () => {
    const messages = [
      userTurn('m0', 'unrelated', 1000),
      userTurn('m1', 'fix the bug', 5000),
      userTurn('m2', 'ship the fix', 6000)
    ]
    const stuckHead = pendingSend('p0', 'bug', 'm0')
    const pair = [pendingSend('p1', 'ship the', 'm0'), pendingSend('p2', 'fix', 'm0')]
    expect(retiredIds(messages, [stuckHead, ...pair])).toEqual(['p1', 'p2'])
  })

  // Nothing bounds how many sends pile onto the agent's input line, so the
  // slide's budget must never truncate a genuine glue.
  it('retires a glued run far longer than the slide budget', () => {
    const words = Array.from({ length: 12 }, (_, index) => `w${index}`)
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', words.join(' '), 5000)]
    const pending = words.map((word, index) => pendingSend(`p${index}`, word, 'm1'))
    expect(retiredIds(messages, pending)).toHaveLength(words.length)
  })

  it('skips a caption-less image echo instead of gluing it', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [
      { ...pendingSend('p1', '', 'm1'), images: ['file:///a.png'] },
      pendingSend('p2', 'one', 'm1'),
      pendingSend('p3', 'two', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p2', 'p3'])
  })

  it('keeps a captioned image echo out of a glue run entirely', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [
      { ...pendingSend('p1', 'one', 'm1'), images: ['file:///a.png'] },
      pendingSend('p2', 'two', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('does nothing for a single pending send', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    expect(retiredIds(messages, [pendingSend('p1', 'one', 'm1')])).toEqual([])
  })

  // The cursor slides past a head that cannot match, so a turn may try several
  // start positions — but one inspection budget covers the whole slide, keeping
  // the work linear in the run length rather than quadratic. The attempt already
  // in flight is allowed to overshoot the remaining budget, deliberately: that is
  // what guarantees a genuine long glue is never truncated.
  it('keeps segment inspection linear in the run length per transcript turn', () => {
    const pendingCount = 96
    const turnCount = 12
    const text = `${'a '.repeat(pendingCount)}x`
    const messages = [
      assistantTurn('tail', 'ready', 1000),
      ...Array.from({ length: turnCount }, (_, index) => userTurn(`m${index}`, text, 2000 + index))
    ]
    const pending = Array.from({ length: pendingCount }, (_, index) =>
      pendingSend(`p${index}`, 'a', 'tail')
    )
    const startsWith = vi.spyOn(String.prototype, 'startsWith')
    let segmentChecks = 0
    try {
      expect(retiredIds(messages, pending)).toEqual([])
      segmentChecks = startsWith.mock.calls.length
    } finally {
      startsWith.mockRestore()
    }
    expect(segmentChecks).toBeLessThanOrEqual(turnCount * (2 * pendingCount + GLUE_SLIDE_BUDGET))
  })
})
