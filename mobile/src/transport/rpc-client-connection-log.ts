import type { ConnectionLogLevel, ConnectionLogSink } from './types'

export type ConnectionLogEmitter = (
  level: ConnectionLogLevel,
  message: string,
  detail?: string
) => void

export function createConnectionLogEmitter(
  onLog: ConnectionLogSink | undefined
): ConnectionLogEmitter {
  let logCounter = 0
  return function emitLog(level: ConnectionLogLevel, message: string, detail?: string) {
    if (!onLog) {
      return
    }
    onLog({
      id: `log-${++logCounter}-${Date.now()}`,
      ts: Date.now(),
      level,
      message,
      detail
    })
  }
}

// Why: keep device tokens / full URLs out of log scrolls — truncate to host:port,
// dropping any `user:password@` userinfo the authority may carry.
export function redactedEndpoint(ep: string): string {
  try {
    const m = ep.match(/^wss?:\/\/([^/]+)/i)
    if (!m) {
      return 'unknown'
    }
    const authority = m[1]
    const at = authority.lastIndexOf('@')
    return at !== -1 ? authority.slice(at + 1) : authority
  } catch {
    return 'unknown'
  }
}
