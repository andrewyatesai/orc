/**
 * §5.3 multiplex contract: one await over N panes, first matching event wins,
 * and the returned cursors must make a one-shot transport lossless across the
 * re-arm window.
 */
import { describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import {
  TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR,
  TerminalEventJournal,
  type EventCursor,
  type PtyEventSource
} from './terminal-event-journal'
import {
  awaitFirstTerminalEvent,
  type TerminalAwaitCursor,
  type TerminalAwaitPane,
  type TerminalAwaitResult
} from './terminal-multi-pane-await'

const RUNTIME_ID = 'runtime-1'

function source(ptyId: string, incarnation = `${ptyId}#a`): PtyEventSource {
  return { runtimeId: RUNTIME_ID, ptyId, ptyIncarnationId: incarnation }
}

function pane(terminal: string, ptyId: string, incarnation = `${ptyId}#a`): TerminalAwaitPane {
  return {
    terminal,
    ptyId,
    cursor: { runtimeId: RUNTIME_ID, ptyIncarnationId: incarnation, eventSeq: 0 }
  }
}

function cursorFor(cursors: readonly TerminalAwaitCursor[], terminal: string): EventCursor {
  const found = cursors.find((entry) => entry.terminal === terminal)
  if (!found) {
    throw new Error(`no cursor for ${terminal}`)
  }
  return found.cursor
}

function factKinds(result: TerminalAwaitResult): string[] {
  if (result.outcome !== 'event') {
    throw new Error(`expected event, got ${result.outcome}`)
  }
  return result.events.map((event) => event.payload.kind)
}

/** A journal whose event timestamps advance one tick per publish, so
 *  "oldest match wins" is decided by publish order rather than wall clock. */
function tickingJournal(): TerminalEventJournal {
  let tick = 0
  return new TerminalEventJournal({
    now: () => {
      tick += 1
      return tick
    }
  })
}

const AGENT_IDLE: TerminalSideEffectFact = { kind: 'agent-idle', title: 'Codex done' }
const AGENT_WORKING: TerminalSideEffectFact = { kind: 'agent-working' }
const BELL: TerminalSideEffectFact = { kind: 'bell' }

describe('awaitFirstTerminalEvent across a watch set', () => {
  it('returns the first matching event and a cursor for every pane', async () => {
    const journal = tickingJournal()
    journal.publish(source('pty-b'), AGENT_IDLE)

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a'), pane('h-b', 'pty-b')],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    expect(result.outcome).toBe('event')
    expect(result.outcome === 'event' && result.terminal).toBe('h-b')
    expect(factKinds(result)).toEqual(['agent-idle'])
    expect(result.cursors.map((entry) => entry.terminal)).toEqual(['h-a', 'h-b'])
    expect(cursorFor(result.cursors, 'h-a').eventSeq).toBe(0)
    expect(cursorFor(result.cursors, 'h-b').eventSeq).toBe(1)
  })

  it('picks the oldest match across panes and leaves the loser its own match', async () => {
    const journal = tickingJournal()
    journal.publish(source('pty-b'), AGENT_IDLE) // older
    journal.publish(source('pty-a'), AGENT_IDLE) // newer

    const first = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a'), pane('h-b', 'pty-b')],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    expect(first.outcome === 'event' && first.terminal).toBe('h-b')
    // The unreturned pane's cursor must still be before its own match.
    const second = await awaitFirstTerminalEvent({
      journal,
      panes: [
        { terminal: 'h-a', ptyId: 'pty-a', cursor: cursorFor(first.cursors, 'h-a') },
        { terminal: 'h-b', ptyId: 'pty-b', cursor: cursorFor(first.cursors, 'h-b') }
      ],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    expect(second.outcome === 'event' && second.terminal).toBe('h-a')
    expect(factKinds(second)).toEqual(['agent-idle'])
  })

  it('consumes filtered-out events instead of re-delivering them on the next arm', async () => {
    const journal = tickingJournal()
    journal.publishBatch(source('pty-a'), [BELL, BELL])
    journal.publish(source('pty-b'), AGENT_IDLE)

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a'), pane('h-b', 'pty-b')],
      matches: (fact) => fact.kind === 'agent-idle',
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    expect(result.outcome === 'event' && result.terminal).toBe('h-b')
    expect(cursorFor(result.cursors, 'h-a').eventSeq).toBe(2)
  })

  it('loses nothing published between a return and the next arm', async () => {
    const journal = tickingJournal()
    journal.publish(source('pty-a'), AGENT_WORKING)

    const first = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a')],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })
    // Published while nobody is watching — the one-shot transport's dead window.
    journal.publish(source('pty-a'), AGENT_IDLE)

    const second = await awaitFirstTerminalEvent({
      journal,
      panes: [{ terminal: 'h-a', ptyId: 'pty-a', cursor: cursorFor(first.cursors, 'h-a') }],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    expect(factKinds(first)).toEqual(['agent-working'])
    expect(factKinds(second)).toEqual(['agent-idle'])
  })

  it('wakes a parked await when a pane publishes', async () => {
    const journal = tickingJournal()
    const pending = awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a'), pane('h-b', 'pty-b')],
      isPaneLive: () => true,
      timeoutMs: 5_000
    })
    await Promise.resolve()
    expect(journal.pendingReaderCount()).toBe(2)

    journal.publish(source('pty-b'), AGENT_IDLE)

    const result = await pending
    expect(result.outcome === 'event' && result.terminal).toBe('h-b')
    // Both parked readers released — the long-poll slot is per request.
    expect(journal.pendingReaderCount()).toBe(0)
  })
})

describe('awaitFirstTerminalEvent explicit non-event outcomes', () => {
  it('surfaces a gap with the resync cursor rather than skipping events', async () => {
    const journal = new TerminalEventJournal({ retentionPerPty: 2 })
    journal.publishBatch(source('pty-a'), [BELL, BELL, BELL])

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a')],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    expect(result.outcome).toBe('gap')
    expect(result.outcome === 'gap' && result.reason).toBe('evicted')
    // Resuming from the gap cursor replays what is left, never gapping twice.
    const resumed = await awaitFirstTerminalEvent({
      journal,
      panes: [{ terminal: 'h-a', ptyId: 'pty-a', cursor: cursorFor(result.cursors, 'h-a') }],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })
    expect(factKinds(resumed)).toEqual(['bell', 'bell'])
  })

  it('reports a dead pane instead of parking out the full timeout', async () => {
    const journal = tickingJournal()

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a'), pane('h-b', 'pty-b')],
      isPaneLive: (ptyId) => ptyId !== 'pty-b',
      timeoutMs: 60_000
    })

    expect(result.outcome).toBe('exit')
    expect(result.outcome === 'exit' && result.terminal).toBe('h-b')
    expect(journal.pendingReaderCount()).toBe(0)
  })

  it('delivers pending events before reporting a dead pane', async () => {
    const journal = tickingJournal()
    journal.publish(source('pty-b'), AGENT_IDLE)

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-b', 'pty-b')],
      isPaneLive: () => false,
      timeoutMs: 60_000
    })

    expect(factKinds(result)).toEqual(['agent-idle'])
  })

  it('times out with every pane cursor intact and no parked readers', async () => {
    const journal = tickingJournal()

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a')],
      isPaneLive: () => true,
      timeoutMs: 10
    })

    expect(result.outcome).toBe('timeout')
    expect(cursorFor(result.cursors, 'h-a').eventSeq).toBe(0)
    expect(journal.pendingReaderCount()).toBe(0)
  })

  it('rechecks liveness while parked instead of hanging to the deadline', async () => {
    vi.useFakeTimers()
    try {
      const journal = tickingJournal()
      let live = true
      const pending = awaitFirstTerminalEvent({
        journal,
        panes: [pane('h-a', 'pty-a')],
        isPaneLive: () => live,
        timeoutMs: 600_000
      })
      await Promise.resolve()
      live = false

      await vi.advanceTimersByTimeAsync(2_000)
      await expect(pending).resolves.toMatchObject({ outcome: 'exit', terminal: 'h-a' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with request_aborted and frees every parked reader on disconnect', async () => {
    const journal = tickingJournal()
    const controller = new AbortController()
    const pending = awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a'), pane('h-b', 'pty-b')],
      isPaneLive: () => true,
      timeoutMs: 60_000,
      signal: controller.signal
    })
    await Promise.resolve()
    expect(journal.pendingReaderCount()).toBe(2)

    controller.abort()

    await expect(pending).rejects.toThrow('request_aborted')
    expect(journal.pendingReaderCount()).toBe(0)
  })

  it('surfaces the pty-dropped gap the journal settled its parked reader with', async () => {
    const journal = tickingJournal()
    journal.publish(source('pty-a'), AGENT_IDLE)
    const armed = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a')],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    const pending = awaitFirstTerminalEvent({
      journal,
      panes: [{ terminal: 'h-a', ptyId: 'pty-a', cursor: cursorFor(armed.cursors, 'h-a') }],
      // Liveness stays true, so only the journal's own reason can end this park.
      isPaneLive: () => true,
      timeoutMs: 100
    })
    await Promise.resolve()
    journal.dropPty('pty-a')

    await expect(pending).resolves.toMatchObject({ outcome: 'gap', reason: 'pty-dropped' })
  })

  it('gaps a pane whose cursor was refused instead of reading against it', async () => {
    const journal = tickingJournal()
    journal.publish(source('pty-a'), AGENT_IDLE)

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [{ ...pane('h-a', 'pty-a'), resyncReason: 'cursor-out-of-range' }],
      isPaneLive: () => true,
      timeoutMs: 1_000
    })

    expect(result).toMatchObject({
      outcome: 'gap',
      terminal: 'h-a',
      reason: 'cursor-out-of-range'
    })
  })

  it('answers unsupported rather than parking for a kind nothing can produce', async () => {
    const journal = tickingJournal()

    const result = await awaitFirstTerminalEvent({
      journal,
      panes: [pane('h-a', 'pty-a')],
      isPaneLive: () => true,
      unproducibleKinds: () => ['bell'],
      timeoutMs: 60_000
    })

    expect(result).toMatchObject({
      outcome: 'unsupported',
      kinds: ['bell'],
      reason: 'no-side-effect-consumer'
    })
    expect(journal.pendingReaderCount()).toBe(0)
  })

  it('releases the watches it opened when the journal refuses another reader', async () => {
    const journal = new TerminalEventJournal({ maxWaiters: 1 })

    await expect(
      awaitFirstTerminalEvent({
        journal,
        panes: [pane('h-a', 'pty-a'), pane('h-b', 'pty-b')],
        isPaneLive: () => true,
        timeoutMs: 1_000
      })
    ).rejects.toThrow(TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR)
    // The first pane parked before the second threw; it must not stay parked.
    expect(journal.pendingReaderCount()).toBe(0)
  })

  it('rejects immediately when the caller is already gone', async () => {
    const journal = tickingJournal()
    await expect(
      awaitFirstTerminalEvent({
        journal,
        panes: [pane('h-a', 'pty-a')],
        isPaneLive: () => true,
        timeoutMs: 60_000,
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow('request_aborted')
    expect(journal.pendingReaderCount()).toBe(0)
  })
})
