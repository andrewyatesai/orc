import type { MessageRow } from './types'
import { exposeUtcTimestamp } from './db-row-timestamp-exposure'

// Why: SQLite stores UTC as timezone-less space format for SQL ordering, but
// RPC/CLI consumers need an explicit offset (#9167). The Rust store returns the
// rows as written; this module owns the RFC3339 exposure at the JSON boundary.
export function exposeMessageTimestamps(message: MessageRow): MessageRow {
  return {
    ...message,
    created_at: exposeUtcTimestamp(message.created_at) ?? message.created_at,
    delivered_at: exposeUtcTimestamp(message.delivered_at)
  }
}

export function messageRowFromJson(json: string): MessageRow {
  return exposeMessageTimestamps(JSON.parse(json) as MessageRow)
}

export function optionalMessageRowFromJson(json: string | null): MessageRow | undefined {
  return json === null ? undefined : messageRowFromJson(json)
}

export function messageListFromJson(json: string): MessageRow[] {
  return (JSON.parse(json) as MessageRow[]).map(exposeMessageTimestamps)
}
