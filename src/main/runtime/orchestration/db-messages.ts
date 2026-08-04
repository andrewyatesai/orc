import {
  OrchestrationStoreBridge,
  generateId,
  paramsJson,
  typesFilter
} from './orchestration-store-bridge'
import {
  messageListFromJson,
  messageRowFromJson,
  optionalMessageRowFromJson
} from './db-message-timestamp'
import type { MessageDeliveryContract, MessagePriority, MessageRow, MessageType } from './types'

export class OrchestrationMessageStore extends OrchestrationStoreBridge {
  insertMessage(msg: {
    id?: string
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
    // senderPaneKey is the remint-stable pane identity persisted with the row so
    // worker_done/heartbeat lifecycle authority survives handle remints (v6 col).
    senderPaneKey?: string
    // recipientPaneKey lets delivery follow the pane after the addressed handle
    // goes stale (#9163, v7 col).
    recipientPaneKey?: string
    runId?: string
    deliveryContract?: MessageDeliveryContract
  }): MessageRow {
    return messageRowFromJson(
      this.store.insertRunMessage(paramsJson({ ...msg, id: msg.id ?? generateId('msg') }))
    )
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return messageListFromJson(this.store.getUnreadMessages(toHandle, typesFilter(types)))
  }

  // Why: rewrites a superseded worker_done/heartbeat into a high-priority
  // rejection (subject/body/payload marker) so it stays auditable but is never
  // read back as an actionable completion/liveness signal. The marker
  // construction is deterministic, so it lives in the Rust store, not here.
  convertLifecycleMessageToRejection(
    messageId: string,
    code: string,
    reason: string
  ): MessageRow | undefined {
    return optionalMessageRowFromJson(
      this.store.convertLifecycleMessageToRejection(messageId, code, reason)
    )
  }

  // Why: delivered_at IS NULL filter — push-on-idle delivers each row at most once; read (set only by check) wouldn't prevent replay.
  getUndeliveredUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return messageListFromJson(
      this.store.getUndeliveredUnreadMessages(toHandle, typesFilter(types))
    )
  }

  getAllMessages(toHandle: string, limit = 20): MessageRow[] {
    return messageListFromJson(this.store.getAllMessages(toHandle, limit))
  }

  getMessageById(id: string): MessageRow | undefined {
    return optionalMessageRowFromJson(this.store.getMessageById(id))
  }

  markAsRead(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    this.store.markAsRead(ids)
  }

  markAsDelivered(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    this.store.markAsDelivered(ids)
  }

  // Why: superseded lifecycle messages stay queryable through history but must
  // not be consumed or injected after their dispatch has finished. The store
  // preserves an existing delivered_at (COALESCE) rather than restamping it.
  markAsReadAndDelivered(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    this.store.markAsReadAndDelivered(ids)
  }

  getInbox(limit = 20): MessageRow[] {
    return messageListFromJson(this.store.getInbox(limit))
  }

  // Why: read-only history for a handle — returns every message regardless of read/delivered state, never flips the read bit (§3.3).
  getAllMessagesForHandle(toHandle: string, limit = 100, types?: MessageType[]): MessageRow[] {
    return messageListFromJson(
      this.store.getAllMessagesForHandle(toHandle, limit, typesFilter(types))
    )
  }

  // Why: ask wait-loop read — to_handle filter shows only replies to the worker; afterSequence resumes past its own outbound ask.
  getThreadMessagesFor(threadId: string, toHandle: string, afterSequence?: number): MessageRow[] {
    return messageListFromJson(this.store.getThreadMessagesFor(threadId, toHandle, afterSequence))
  }
}
