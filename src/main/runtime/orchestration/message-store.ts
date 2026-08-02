import {
  requireRustGitBinding,
  type RustOrchestrationStoreHandle
} from '../../daemon/rust-git-addon'
import type { MessageType, MessagePriority, MessageRow } from './types'
import {
  messageListFromJson,
  messageRowFromJson,
  optionalMessageRowFromJson
} from './db-message-timestamp'
import { generateId } from './row-id'

// Why: the store treats an empty filter as "no filter"; normalize before crossing napi.
function typesFilter(types?: MessageType[]): MessageType[] | undefined {
  return types && types.length > 0 ? types : undefined
}

/**
 * The message half of the orchestration shim. Split out of db.ts so the store
 * class stays inside the file budget as schema v9's surface lands; messages are
 * the natural seam because they already own a second module (db-message-timestamp)
 * for the one thing Rust must not decide — how a timestamp is spelled in JS.
 *
 * Owns the napi store handle and its lifecycle, so subclasses inherit both.
 */
export class OrchestrationMessageStore {
  protected store: RustOrchestrationStoreHandle

  constructor(dbPath: string | ':memory:') {
    // Lazy-require so merely importing this module never forces the native addon
    // to load — only an actual store instantiation depends on it.
    this.store = new (requireRustGitBinding().OrchestrationStore)(dbPath)
  }

  insertMessage(msg: {
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
    senderPaneKey?: string
    recipientPaneKey?: string
  }): MessageRow {
    // senderPaneKey is the remint-stable pane identity persisted with the row so
    // worker_done/heartbeat lifecycle authority survives handle remints (v6 col).
    // recipientPaneKey lets delivery follow the pane after the addressed handle
    // goes stale (#9163, v7 col).
    return messageRowFromJson(
      this.store.insertMessage(
        generateId('msg'),
        msg.from,
        msg.to,
        msg.subject,
        msg.body ?? '',
        msg.type ?? 'status',
        msg.priority ?? 'normal',
        msg.threadId ?? null,
        msg.payload ?? null,
        msg.senderPaneKey ?? null,
        msg.recipientPaneKey ?? null
      )
    )
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return messageListFromJson(this.store.getUnreadMessages(toHandle, typesFilter(types)))
  }

  // Why: rewrites a superseded worker_done/heartbeat into a high-priority
  // rejection (subject/body/payload marker) so it stays auditable but is never
  // read back as an actionable completion/liveness signal. The marker
  // construction is deterministic, so it lives in the Rust store, not here.
  convertLifecycleMessageToRejection(messageId: string, reason: string): MessageRow | undefined {
    return optionalMessageRowFromJson(
      this.store.convertLifecycleMessageToRejection(messageId, reason)
    )
  }

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

  getAllMessagesForHandle(toHandle: string, limit = 100, types?: MessageType[]): MessageRow[] {
    return messageListFromJson(
      this.store.getAllMessagesForHandle(toHandle, limit, typesFilter(types))
    )
  }

  getThreadMessagesFor(threadId: string, toHandle: string, afterSequence?: number): MessageRow[] {
    return messageListFromJson(this.store.getThreadMessagesFor(threadId, toHandle, afterSequence))
  }

  resetMessages(): void {
    this.store.resetMessages()
  }

  close(): void {
    this.store.close()
  }
}
