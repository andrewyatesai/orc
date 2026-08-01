import { describe, expect, it } from 'vitest'
import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import {
  TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR,
  TERMINAL_EVENT_JOURNAL_RETENTION,
  TerminalEventJournal,
  type EventCursor,
  type JournalReadResult,
  type JournalWatchResult,
  type PtyEventSource
} from './terminal-event-journal'

type NumberedFact = { n: number }

const RUNTIME_ID = 'runtime-1'
const INCARNATION_A = 'pty-1#a'
const INCARNATION_B = 'pty-1#b'

function source(ptyId: string, ptyIncarnationId: string): PtyEventSource {
  return { runtimeId: RUNTIME_ID, ptyId, ptyIncarnationId }
}

function startCursor(ptyIncarnationId: string): EventCursor {
  return { runtimeId: RUNTIME_ID, ptyIncarnationId, eventSeq: 0 }
}

function numbers(result: JournalWatchResult<NumberedFact>): number[] {
  if (result.kind !== 'events') {
    throw new Error(`expected events, got ${result.kind}`)
  }
  return result.events.map((event) => event.payload.n)
}

function sequences(result: JournalWatchResult<NumberedFact>): number[] {
  if (result.kind !== 'events') {
    throw new Error(`expected events, got ${result.kind}`)
  }
  return result.events.map((event) => event.eventSeq)
}

function gapOf(
  result: JournalWatchResult<NumberedFact>
): Extract<JournalReadResult<NumberedFact>, { kind: 'gap' }> {
  if (result.kind !== 'gap') {
    throw new Error(`expected a gap, got ${result.kind}`)
  }
  return result
}

function cursorAt(ptyIncarnationId: string, eventSeq: number): EventCursor {
  return { runtimeId: RUNTIME_ID, ptyIncarnationId, eventSeq }
}

// Two turns: one for the settle resolve, one for the awaiting continuation.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TerminalEventJournal ordering and identity', () => {
  it('mints its own monotonic per-incarnation ordinal in publish order', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    journal.publishBatch(source('pty-1', INCARNATION_A), [{ n: 2 }, { n: 3 }])

    const result = journal.read('pty-1', startCursor(INCARNATION_A))
    expect(numbers(result)).toEqual([1, 2, 3])
    if (result.kind !== 'events') {
      throw new Error('expected events')
    }
    expect(result.events.map((event) => event.eventSeq)).toEqual([1, 2, 3])
    expect(result.nextCursor).toEqual({
      runtimeId: RUNTIME_ID,
      ptyIncarnationId: INCARNATION_A,
      eventSeq: 3
    })
  })

  it('stamps events from the injected clock and carries the pty id', () => {
    let ticks = 100
    const journal = new TerminalEventJournal<NumberedFact>({
      now: () => {
        ticks += 1
        return ticks
      }
    })
    journal.publishBatch(source('pty-1', INCARNATION_A), [{ n: 1 }, { n: 2 }])

    const result = journal.read('pty-1', startCursor(INCARNATION_A))
    if (result.kind !== 'events') {
      throw new Error('expected events')
    }
    expect(result.events.map((event) => event.at)).toEqual([101, 102])
    expect(result.events.map((event) => event.ptyId)).toEqual(['pty-1', 'pty-1'])
  })

  it('reads nothing newer when the cursor is already at head', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const head = journal.publish(source('pty-1', INCARNATION_A), { n: 1 })

    const result = journal.read('pty-1', head)
    expect(numbers(result)).toEqual([])
    expect(result.kind === 'events' && result.nextCursor).toEqual(head)
  })

  it('reports empty rather than a gap for a pane that has not published yet', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    expect(numbers(journal.read('pty-unknown', startCursor(INCARNATION_A)))).toEqual([])
    expect(journal.headCursor('pty-unknown')).toBeUndefined()
    expect(journal.earliestCursor('pty-unknown')).toBeUndefined()
  })

  it('rejects a non-positive retention', () => {
    expect(() => new TerminalEventJournal({ retentionPerPty: 0 })).toThrow(/positive integer/)
    expect(TERMINAL_EVENT_JOURNAL_RETENTION).toBeGreaterThan(0)
  })

  it('accepts terminal side-effect facts as the default payload shape', () => {
    const journal = new TerminalEventJournal()
    const fact: TerminalSideEffectFact = { kind: 'agent-idle', title: 'done' }
    journal.publish(source('pty-1', INCARNATION_A), fact)

    const result = journal.read('pty-1', startCursor(INCARNATION_A))
    if (result.kind !== 'events') {
      throw new Error('expected events')
    }
    expect(result.events[0].payload).toEqual(fact)
  })
})

describe('TerminalEventJournal per-PTY isolation', () => {
  it('keeps ordinals and retention per pane', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    journal.publish(source('pty-2', 'pty-2#a'), { n: 10 })
    journal.publish(source('pty-1', INCARNATION_A), { n: 2 })

    expect(numbers(journal.read('pty-1', startCursor(INCARNATION_A)))).toEqual([1, 2])
    expect(numbers(journal.read('pty-2', startCursor('pty-2#a')))).toEqual([10])
    expect(journal.headCursor('pty-2')?.eventSeq).toBe(1)
  })

  it('does not wake a reader parked on another pane', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const watch = journal.watch('pty-1', startCursor(INCARNATION_A))
    let settled = false
    void watch.result.then(() => {
      settled = true
    })

    journal.publish(source('pty-2', 'pty-2#a'), { n: 10 })
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(journal.pendingReaderCount('pty-1')).toBe(1)
    expect(journal.pendingReaderCount()).toBe(1)

    watch.cancel()
    await watch.result
  })
})

describe('TerminalEventJournal bounded retention', () => {
  it('signals an explicit gap instead of silently truncating', () => {
    const journal = new TerminalEventJournal<NumberedFact>({ retentionPerPty: 3 })
    for (let n = 1; n <= 5; n += 1) {
      journal.publish(source('pty-1', INCARNATION_A), { n })
    }

    const gap = journal.read('pty-1', startCursor(INCARNATION_A))
    expect(gap).toEqual({
      kind: 'gap',
      reason: 'evicted',
      nextCursor: { runtimeId: RUNTIME_ID, ptyIncarnationId: INCARNATION_A, eventSeq: 2 }
    })

    if (gap.kind !== 'gap') {
      throw new Error('expected a gap')
    }
    // Resuming at the gap's cursor returns everything still retained, no second gap.
    expect(numbers(journal.read('pty-1', gap.nextCursor))).toEqual([3, 4, 5])
  })

  it('does not gap a cursor sitting exactly on the eviction boundary', () => {
    const journal = new TerminalEventJournal<NumberedFact>({ retentionPerPty: 3 })
    for (let n = 1; n <= 5; n += 1) {
      journal.publish(source('pty-1', INCARNATION_A), { n })
    }

    const boundary: EventCursor = {
      runtimeId: RUNTIME_ID,
      ptyIncarnationId: INCARNATION_A,
      eventSeq: 2
    }
    expect(numbers(journal.read('pty-1', boundary))).toEqual([3, 4, 5])
    expect(journal.earliestCursor('pty-1')?.eventSeq).toBe(2)
  })

  it('gaps a parked reader whose position is evicted while it waits', async () => {
    const journal = new TerminalEventJournal<NumberedFact>({ retentionPerPty: 2 })
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    const watch = journal.watch('pty-1', journal.headCursor('pty-1') as EventCursor)

    journal.publishBatch(source('pty-1', INCARNATION_A), [{ n: 2 }, { n: 3 }, { n: 4 }])

    const result = await watch.result
    expect(result.kind).toBe('gap')
    expect(result.kind === 'gap' && result.reason).toBe('evicted')
  })
})

describe('TerminalEventJournal replay-then-park race', () => {
  it('parks synchronously, so an event published right after registering is delivered', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const watch = journal.watch('pty-1', startCursor(INCARNATION_A))
    let settled = false
    void watch.result.then(() => {
      settled = true
    })

    // The park is already in place before control returns from watch().
    expect(journal.pendingReaderCount('pty-1')).toBe(1)
    expect(settled).toBe(false)

    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    expect(numbers(await watch.result)).toEqual([1])
    expect(settled).toBe(true)
    expect(journal.pendingReaderCount('pty-1')).toBe(0)
  })

  it('replays events published in the window between resolve and re-arm', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const first = journal.watch('pty-1', startCursor(INCARNATION_A))
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    const firstResult = await first.result
    expect(numbers(firstResult)).toEqual([1])

    // The one-shot RPC has returned; these land while nothing is watching.
    journal.publish(source('pty-1', INCARNATION_A), { n: 2 })
    journal.publish(source('pty-1', INCARNATION_A), { n: 3 })

    const second = journal.watch('pty-1', firstResult.nextCursor)
    expect(journal.pendingReaderCount('pty-1')).toBe(0) // replayed, never parked
    expect(numbers(await second.result)).toEqual([2, 3])
  })

  it('loses nothing across a re-arm loop interleaved with publishes', async () => {
    const journal = new TerminalEventJournal<NumberedFact>({ retentionPerPty: 64 })
    const received: number[] = []
    let cursor = startCursor(INCARNATION_A)
    let iterations = 0

    const pump = (async () => {
      while (received.length < 50 && iterations < 500) {
        iterations += 1
        const result = await journal.watch('pty-1', cursor).result
        if (result.kind !== 'events') {
          throw new Error(`unexpected ${result.kind}`)
        }
        for (const event of result.events) {
          received.push(event.payload.n)
        }
        cursor = result.nextCursor
      }
    })()

    for (let n = 1; n <= 50; n += 1) {
      journal.publish(source('pty-1', INCARNATION_A), { n })
      await Promise.resolve()
    }
    await pump

    expect(received).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
  })

  it('delivers an event published from a reader wake-up to the other readers', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const echoed: number[] = []
    const first = journal.watch('pty-1', startCursor(INCARNATION_A))
    const second = journal.watch('pty-1', startCursor(INCARNATION_A))
    void first.result.then((result) => {
      echoed.push(...numbers(result))
      journal.publish(source('pty-1', INCARNATION_A), { n: 2 })
    })

    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    const secondResult = await second.result
    await flushMicrotasks()

    expect(echoed).toEqual([1])
    // The second reader may see the re-entrant publish in the same batch or the
    // next one; either way its cursor never skips an ordinal.
    const seen = numbers(secondResult)
    expect(seen[0]).toBe(1)
    const rest = await journal.watch('pty-1', secondResult.nextCursor).result
    expect([...seen, ...numbers(rest)]).toEqual([1, 2])
  })
})

describe('TerminalEventJournal incarnation invalidation', () => {
  it('gaps a stale cursor instead of serving the next incarnation events', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    const staleCursor = journal.headCursor('pty-1') as EventCursor
    journal.publish(source('pty-1', INCARNATION_B), { n: 99 })

    const result = journal.read('pty-1', staleCursor)
    expect(result).toEqual({
      kind: 'gap',
      reason: 'incarnation-changed',
      nextCursor: { runtimeId: RUNTIME_ID, ptyIncarnationId: INCARNATION_B, eventSeq: 0 }
    })
    expect(numbers(journal.read('pty-1', startCursor(INCARNATION_B)))).toEqual([99])
  })

  it('restarts the ordinal for the new incarnation', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publishBatch(source('pty-1', INCARNATION_A), [{ n: 1 }, { n: 2 }])
    const head = journal.beginIncarnation(source('pty-1', INCARNATION_B))

    expect(head).toEqual({
      runtimeId: RUNTIME_ID,
      ptyIncarnationId: INCARNATION_B,
      eventSeq: 0
    })
    expect(journal.publish(source('pty-1', INCARNATION_B), { n: 3 }).eventSeq).toBe(1)
  })

  it('wakes a parked reader with a gap as soon as the pty respawns', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    const watch = journal.watch('pty-1', journal.headCursor('pty-1') as EventCursor)

    journal.beginIncarnation(source('pty-1', INCARNATION_B))

    const result = await watch.result
    expect(result.kind === 'gap' && result.reason).toBe('incarnation-changed')
    expect(journal.pendingReaderCount('pty-1')).toBe(0)
  })

  it('gaps a cursor from another runtime holding the same incarnation id', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })

    const foreign = journal.read('pty-1', {
      runtimeId: 'runtime-2',
      ptyIncarnationId: INCARNATION_A,
      eventSeq: 0
    })
    expect(foreign.kind === 'gap' && foreign.reason).toBe('incarnation-changed')
  })
})

describe('TerminalEventJournal multiple readers', () => {
  it('gives every reader its own slice from its own cursor', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    const behind = journal.watch('pty-1', startCursor(INCARNATION_A))
    const current = journal.watch('pty-1', journal.headCursor('pty-1') as EventCursor)

    expect(numbers(await behind.result)).toEqual([1])
    expect(journal.pendingReaderCount('pty-1')).toBe(1)

    journal.publish(source('pty-1', INCARNATION_A), { n: 2 })
    expect(numbers(await current.result)).toEqual([2])
    // The first reader's read did not consume anything for the second.
    expect(numbers(journal.read('pty-1', startCursor(INCARNATION_A)))).toEqual([1, 2])
  })

  it('wakes every parked reader on the same pane', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const head = startCursor(INCARNATION_A)
    const watches = [journal.watch('pty-1', head), journal.watch('pty-1', head)]
    expect(journal.pendingReaderCount('pty-1')).toBe(2)

    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })

    const results = await Promise.all(watches.map((watch) => watch.result))
    expect(results.map(numbers)).toEqual([[1], [1]])
    expect(journal.pendingReaderCount('pty-1')).toBe(0)
  })
})

describe('TerminalEventJournal cancellation', () => {
  it('frees the slot when the caller disposes the watch', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const cursor = startCursor(INCARNATION_A)
    const watch = journal.watch('pty-1', cursor)

    watch.cancel()

    expect(await watch.result).toEqual({ kind: 'cancelled', nextCursor: cursor })
    expect(journal.pendingReaderCount('pty-1')).toBe(0)
  })

  it('cancels via an AbortSignal and stops delivering', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const controller = new AbortController()
    const watch = journal.watch('pty-1', startCursor(INCARNATION_A), {
      signal: controller.signal
    })

    controller.abort()
    expect((await watch.result).kind).toBe('cancelled')

    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    expect(journal.pendingReaderCount('pty-1')).toBe(0)
    // The retained event is still there for the next cursor holder.
    expect(numbers(journal.read('pty-1', startCursor(INCARNATION_A)))).toEqual([1])
  })

  it('never parks a watch registered with an already-aborted signal', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const controller = new AbortController()
    controller.abort()

    const watch = journal.watch('pty-1', startCursor(INCARNATION_A), {
      signal: controller.signal
    })
    expect((await watch.result).kind).toBe('cancelled')
    expect(journal.pendingReaderCount()).toBe(0)
  })

  it('ignores a cancel that races the delivery', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const watch = journal.watch('pty-1', startCursor(INCARNATION_A))

    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    watch.cancel()

    expect(numbers(await watch.result)).toEqual([1])
  })

  it('releases parked readers when the pty is dropped', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    const cursor = journal.headCursor('pty-1') as EventCursor
    const watch = journal.watch('pty-1', cursor)

    journal.dropPty('pty-1')

    expect(await watch.result).toEqual({ kind: 'gap', reason: 'pty-dropped', nextCursor: cursor })
    expect(journal.pendingReaderCount()).toBe(0)
    expect(journal.headCursor('pty-1')).toBeUndefined()
  })

  it('releases readers parked on a pane that never published', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    const cursor = startCursor(INCARNATION_A)
    const watch = journal.watch('pty-1', cursor)

    journal.dropPty('pty-1')

    expect(await watch.result).toEqual({ kind: 'gap', reason: 'pty-dropped', nextCursor: cursor })
    expect(journal.pendingReaderCount()).toBe(0)
  })
})

describe('TerminalEventJournal cursor authority', () => {
  it('mints its own ordinal from its own origin, whatever the reader claims', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    // The upper bound the RPC schema accepts, on a pane that has not published:
    // seeding the pane from it would make the increment a float no-op.
    const watch = journal.watch('pty-1', cursorAt(INCARNATION_A, Number.MAX_SAFE_INTEGER))
    expect(journal.headCursor('pty-1')).toBeUndefined()

    for (let n = 1; n <= 5; n += 1) {
      journal.publish(source('pty-1', INCARNATION_A), { n })
    }

    expect(sequences(journal.read('pty-1', startCursor(INCARNATION_A)))).toEqual([1, 2, 3, 4, 5])
    expect(journal.headCursor('pty-1')?.eventSeq).toBe(5)
    // The reader that claimed the future is resynced, not obeyed — and it is
    // told once rather than re-served the same facts on every arm.
    const gap = gapOf(await watch.result)
    expect(gap.reason).toBe('cursor-out-of-range')
    expect(gap.nextCursor).toEqual(cursorAt(INCARNATION_A, 1))
  })

  it('does not allocate a journal record for a pane it has never published to', () => {
    const journal = new TerminalEventJournal<NumberedFact>()

    journal.watch('ghost-1', cursorAt(INCARNATION_A, 4_000)).cancel()
    journal.read('ghost-2', startCursor(INCARNATION_A))

    expect(journal.headCursor('ghost-1')).toBeUndefined()
    expect(journal.earliestCursor('ghost-1')).toBeUndefined()
    expect(journal.pendingReaderCount()).toBe(0)
    expect(journal.publish(source('ghost-1', INCARNATION_A), { n: 1 }).eventSeq).toBe(1)
  })

  it('gaps a cursor ahead of head instead of parking it forever', async () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })

    const gap = gapOf(await journal.watch('pty-1', cursorAt(INCARNATION_A, 500)).result)
    expect(gap.reason).toBe('cursor-out-of-range')
    expect(gap.nextCursor).toEqual(journal.headCursor('pty-1'))
    expect(journal.pendingReaderCount()).toBe(0)

    // Resuming at the returned cursor does not gap again; it resumes the stream.
    expect(numbers(journal.read('pty-1', gap.nextCursor))).toEqual([])
    journal.publish(source('pty-1', INCARNATION_A), { n: 2 })
    expect(numbers(journal.read('pty-1', gap.nextCursor))).toEqual([2])
  })

  it('gaps an ordinal that is not a position at all', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })

    for (const eventSeq of [Number.NaN, -1, 1.5]) {
      const gap = gapOf(journal.read('pty-1', cursorAt(INCARNATION_A, eventSeq)))
      expect(gap.reason).toBe('cursor-out-of-range')
      expect(gap.nextCursor.eventSeq).toBe(1)
    }
  })

  it('checks incarnation identity before the ordinal', () => {
    const journal = new TerminalEventJournal<NumberedFact>({ retentionPerPty: 3 })
    journal.publishBatch(source('pty-1', INCARNATION_B), [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])

    // A cursor naming an incarnation this journal does not hold gets the resync
    // target, whether its ordinal is behind or ahead of the live stream.
    const gap = gapOf(journal.read('pty-1', cursorAt('pty-1#z', 9)))
    expect(gap.reason).toBe('incarnation-changed')
    expect(gap.nextCursor).toEqual(cursorAt(INCARNATION_B, 1))
    // One gap, then the whole retained tail — the resume cursor never gaps again.
    expect(numbers(journal.read('pty-1', gap.nextCursor))).toEqual([2, 3, 4])
  })
})

describe('TerminalEventJournal drop stickiness', () => {
  it('keeps the ordinal above the drop so a surviving cursor gaps, never under-reads', () => {
    const journal = new TerminalEventJournal<NumberedFact>({ retentionPerPty: 6 })
    for (let n = 1; n <= 5; n += 1) {
      journal.publish(source('pty-1', INCARNATION_A), { n })
    }
    const survivor = journal.headCursor('pty-1') as EventCursor

    journal.dropPty('pty-1')
    // Same incarnation id: a reconnect of a pruned-but-live PTY, not a respawn.
    for (let n = 101; n <= 111; n += 1) {
      journal.publish(source('pty-1', INCARNATION_A), { n })
    }

    const gap = gapOf(journal.read('pty-1', survivor))
    expect(gap.reason).toBe('evicted')
    expect(journal.headCursor('pty-1')?.eventSeq).toBe(16)
    expect(numbers(journal.read('pty-1', gap.nextCursor))).toEqual([106, 107, 108, 109, 110, 111])
  })

  it('delivers every post-drop event when retention lost nothing', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    for (let n = 1; n <= 5; n += 1) {
      journal.publish(source('pty-1', INCARNATION_A), { n })
    }
    const survivor = journal.headCursor('pty-1') as EventCursor

    journal.dropPty('pty-1')
    journal.publishBatch(source('pty-1', INCARNATION_A), [{ n: 6 }, { n: 7 }])

    const result = journal.read('pty-1', survivor)
    expect(numbers(result)).toEqual([6, 7])
    expect(sequences(result)).toEqual([6, 7])
  })

  it('restarts the ordinal when the pane comes back as a new incarnation', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publishBatch(source('pty-1', INCARNATION_A), [{ n: 1 }, { n: 2 }])

    journal.dropPty('pty-1')
    journal.publish(source('pty-1', INCARNATION_B), { n: 3 })

    // The incarnation id already invalidates the old cursor, so the ordinal is
    // free to restart — and a stale reader is told which way to resync.
    expect(journal.headCursor('pty-1')).toEqual(cursorAt(INCARNATION_B, 1))
    expect(gapOf(journal.read('pty-1', cursorAt(INCARNATION_A, 2))).reason).toBe(
      'incarnation-changed'
    )
  })

  it('tells a late reader the pane was dropped, then lets it park', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publishBatch(source('pty-1', INCARNATION_A), [{ n: 1 }, { n: 2 }])

    journal.dropPty('pty-1')

    const gap = gapOf(journal.read('pty-1', startCursor(INCARNATION_A)))
    expect(gap.reason).toBe('pty-dropped')
    // The resume cursor parks instead of gapping on every arm — the caller's
    // liveness check is what ends that poll.
    const watch = journal.watch('pty-1', gap.nextCursor)
    expect(journal.pendingReaderCount('pty-1')).toBe(1)
    watch.cancel()
  })

  it('forgets a dropped pane once the tombstone window rolls over', () => {
    const journal = new TerminalEventJournal<NumberedFact>({ droppedPaneMemory: 1 })
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })
    journal.dropPty('pty-1')

    journal.publish(source('pty-2', 'pty-2#a'), { n: 1 })
    journal.dropPty('pty-2')

    // Documented bound: past this many drops the pane is indistinguishable from
    // one this journal has never seen.
    expect(journal.publish(source('pty-1', INCARNATION_A), { n: 2 }).eventSeq).toBe(1)
  })
})

describe('TerminalEventJournal retained history ownership', () => {
  it('hands every reader its own copy of each event', () => {
    const journal = new TerminalEventJournal<NumberedFact>()
    journal.publish(source('pty-1', INCARNATION_A), { n: 1 })

    const first = journal.read('pty-1', startCursor(INCARNATION_A))
    const second = journal.read('pty-1', startCursor(INCARNATION_A))
    if (first.kind !== 'events' || second.kind !== 'events') {
      throw new Error('expected events')
    }
    expect(first.events[0]).not.toBe(second.events[0])
    expect(first.events[0].payload).not.toBe(second.events[0].payload)

    first.events[0].payload.n = 999
    expect(numbers(journal.read('pty-1', startCursor(INCARNATION_A)))).toEqual([1])
  })
})

describe('TerminalEventJournal parked reader caps', () => {
  it('refuses to park past the per-pane cap and reuses a released slot', () => {
    const journal = new TerminalEventJournal<NumberedFact>({ maxWaitersPerPty: 2 })
    const cursor = startCursor(INCARNATION_A)
    const parked = [journal.watch('pty-1', cursor), journal.watch('pty-1', cursor)]

    expect(() => journal.watch('pty-1', cursor)).toThrow(TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR)
    // Other panes are unaffected: the cap is per pane.
    journal.watch('pty-2', cursor).cancel()

    parked[0].cancel()
    const reused = journal.watch('pty-1', cursor)
    expect(journal.pendingReaderCount('pty-1')).toBe(2)
    reused.cancel()
    parked[1].cancel()
    expect(journal.pendingReaderCount()).toBe(0)
  })

  it('refuses to park past the journal-wide cap', () => {
    const journal = new TerminalEventJournal<NumberedFact>({ maxWaiters: 2 })
    const cursor = startCursor(INCARNATION_A)
    journal.watch('pty-1', cursor)
    journal.watch('pty-2', cursor)

    expect(() => journal.watch('pty-3', cursor)).toThrow(TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR)
    expect(journal.pendingReaderCount()).toBe(2)
  })

  it('rejects non-positive bounds', () => {
    expect(() => new TerminalEventJournal({ maxWaitersPerPty: 0 })).toThrow(/positive integer/)
    expect(() => new TerminalEventJournal({ maxWaiters: -1 })).toThrow(/positive integer/)
    expect(() => new TerminalEventJournal({ droppedPaneMemory: 1.5 })).toThrow(/positive integer/)
  })
})
