import { describe, expect, it, vi } from 'vitest'
import { deliverGateResolutionToOrigin, type GateReplyRuntime } from './gate-reply-coupling'
import type { DecisionGateRow, MessageRow, OrchestrationDb } from './db'

function gate(overrides: Partial<DecisionGateRow> = {}): DecisionGateRow {
  return {
    id: 'gate_1',
    run_id: 'run_1',
    task_id: 'task_1',
    question: 'Ship it?',
    options: '["yes","no"]',
    status: 'resolved',
    resolution: 'yes',
    created_at: '2026-01-01 00:00:00',
    resolved_at: '2026-01-01 00:05:00',
    origin_message_id: 'msg_ask',
    ...overrides
  }
}

function originMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg_ask',
    from_handle: 'worker-1',
    to_handle: 'coordinator',
    subject: 'Question',
    body: 'Ship it?',
    type: 'decision_gate',
    thread_id: null,
    sender_pane_key: 'tab_1:leaf_1',
    ...overrides
  } as MessageRow
}

function stubDb(origin: MessageRow | undefined) {
  const insertMessage = vi.fn((input: Record<string, unknown>) => ({
    ...input,
    id: 'msg_reply',
    type: 'status'
  }))
  const markAsRead = vi.fn()
  return {
    db: {
      getMessageById: vi.fn(() => origin),
      insertMessage,
      markAsRead
    } as unknown as OrchestrationDb,
    insertMessage,
    markAsRead
  }
}

function stubRuntime() {
  const runtime: GateReplyRuntime = {
    deliverPendingMessagesForHandle: vi.fn(),
    notifyMessageArrived: vi.fn()
  }
  return runtime as {
    deliverPendingMessagesForHandle: ReturnType<typeof vi.fn>
    notifyMessageArrived: ReturnType<typeof vi.fn>
  } & GateReplyRuntime
}

describe('deliverGateResolutionToOrigin', () => {
  it('answers the asking worker on the origin thread', () => {
    // Why this test exists: resolveGate alone moves the task to ready, so the board clears
    // while the worker stays parked until timeout — a failure that looks like success.
    const origin = originMessage()
    const { db, insertMessage, markAsRead } = stubDb(origin)
    const runtime = stubRuntime()

    const outcome = deliverGateResolutionToOrigin(db, runtime, gate(), 'yes')

    expect(outcome).toEqual({
      delivered: true,
      message: expect.objectContaining({ id: 'msg_reply' })
    })
    expect(markAsRead).toHaveBeenCalledWith(['msg_ask'])
    expect(insertMessage).toHaveBeenCalledWith({
      from: 'coordinator',
      to: 'worker-1',
      subject: 'Re: Question',
      body: 'yes',
      // Thread must be the ask itself so the worker's getThreadMessagesFor loop wakes.
      threadId: 'msg_ask'
    })
    expect(runtime.deliverPendingMessagesForHandle).toHaveBeenCalledWith('worker-1', 'tab_1:leaf_1')
    expect(runtime.notifyMessageArrived).toHaveBeenCalledWith('worker-1', 'status', 'tab_1:leaf_1')
  })

  it('threads onto an existing thread id when the ask was itself a reply', () => {
    const { db, insertMessage } = stubDb(originMessage({ thread_id: 'thread_root' }))
    deliverGateResolutionToOrigin(db, stubRuntime(), gate(), 'no')
    expect(insertMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread_root' }))
  })

  it('routes to the pane that asked, so a reminted handle still receives the answer', () => {
    const { db } = stubDb(originMessage({ sender_pane_key: 'tab_9:leaf_2' }))
    const runtime = stubRuntime()
    deliverGateResolutionToOrigin(db, runtime, gate(), 'yes')
    expect(runtime.deliverPendingMessagesForHandle).toHaveBeenCalledWith('worker-1', 'tab_9:leaf_2')
  })

  it('passes undefined (not null) when the ask carried no pane key', () => {
    const { db } = stubDb(originMessage({ sender_pane_key: null }))
    const runtime = stubRuntime()
    deliverGateResolutionToOrigin(db, runtime, gate(), 'yes')
    expect(runtime.deliverPendingMessagesForHandle).toHaveBeenCalledWith('worker-1', undefined)
  })

  it('is a no-op for a gate with no origin — gateCreate, or any pre-v8 row', () => {
    const { db, insertMessage } = stubDb(originMessage())
    const runtime = stubRuntime()

    const outcome = deliverGateResolutionToOrigin(
      db,
      runtime,
      gate({ origin_message_id: null }),
      'yes'
    )

    expect(outcome).toEqual({ delivered: false, reason: 'no-origin' })
    expect(insertMessage).not.toHaveBeenCalled()
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalled()
  })

  it('does not throw when the origin message was purged — the gate still resolved', () => {
    const { db, insertMessage } = stubDb(undefined)
    const runtime = stubRuntime()

    const outcome = deliverGateResolutionToOrigin(db, runtime, gate(), 'yes')

    expect(outcome).toEqual({ delivered: false, reason: 'origin-missing' })
    expect(insertMessage).not.toHaveBeenCalled()
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalled()
  })
})
