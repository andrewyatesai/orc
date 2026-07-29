import type { DecisionGateRow, MessageRow, OrchestrationDb } from './db'

/**
 * The runtime surface a gate reply needs. Narrowed to the three calls
 * `orchestration.reply` already makes, so this module stays unit-testable.
 */
export type GateReplyRuntime = {
  deliverPendingMessagesForHandle: (handle: string, paneKey?: string) => void
  notifyMessageArrived: (handle: string, type: string, paneKey?: string) => void
}

export type GateReplyOutcome =
  | { delivered: false; reason: 'no-origin' | 'origin-missing' }
  | { delivered: true; message: MessageRow }

/**
 * Answer the `ask` that opened a gate.
 *
 * Why this exists: `resolveGate` moves the task back to `ready`, so the board clears —
 * but the worker that called `ask` is parked in a loop over `getThreadMessagesFor`,
 * whose only producer is `orchestration.reply`. Without a reply the worker hangs to its
 * timeout while every surface reports success, which is the worst failure mode available:
 * it looks fixed.
 *
 * Degrades quietly by design: a gate opened by `gateCreate`, or by any build before
 * schema v8, carries no origin and simply has nothing to answer.
 */
export function deliverGateResolutionToOrigin(
  db: OrchestrationDb,
  runtime: GateReplyRuntime,
  gate: DecisionGateRow,
  resolution: string
): GateReplyOutcome {
  const originId = gate.origin_message_id
  if (!originId) {
    return { delivered: false, reason: 'no-origin' }
  }
  const origin = db.getMessageById(originId)
  if (!origin) {
    // Why not throw: the gate did resolve and the task is already unblocked. Failing here
    // would report an error for work that succeeded, and the ask will still time out safely.
    return { delivered: false, reason: 'origin-missing' }
  }

  db.markAsRead([origin.id])
  const reply = db.insertMessage({
    // The ask's recipient answers its sender — the same direction orchestration.reply uses.
    from: origin.to_handle,
    to: origin.from_handle,
    subject: `Re: ${origin.subject}`,
    body: resolution,
    threadId: origin.thread_id ?? origin.id
  })

  // Why sender_pane_key: the asker may have been reminted while blocked, so route the
  // answer to the pane that sent the question rather than to a possibly-stale handle.
  const originPaneKey = origin.sender_pane_key ?? undefined
  runtime.deliverPendingMessagesForHandle(origin.from_handle, originPaneKey)
  runtime.notifyMessageArrived(origin.from_handle, reply.type, originPaneKey)
  return { delivered: true, message: reply }
}
