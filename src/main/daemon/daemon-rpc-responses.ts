// ─── RPC Responses (Daemon → Client, on control socket) ────────────
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { TerminalSnapshot } from './terminal-snapshot'
import type { SessionState, ShellReadyState } from './types'

export type RpcResponseOk<T = unknown> = {
  id: string
  ok: true
  payload: T
}

export type RpcResponseError = {
  id: string
  ok: false
  error: string
}

export type RpcResponse<T = unknown> = RpcResponseOk<T> | RpcResponseError

export type { DaemonCreateOrAttachResult as CreateOrAttachResult } from './daemon-create-or-attach-result'
export type GetSnapshotResult = {
  snapshot: TerminalSnapshot | null
}

export type ListSessionsResult = {
  sessions: SessionInfo[]
}

export type ShutdownIfIdleResult = {
  retiring: boolean
}

export type SystemResolverHealth = 'healthy' | 'unhealthy' | 'unknown'

export type SystemResolverHealthResult = {
  health: SystemResolverHealth
}

export type SessionInfo = {
  sessionId: string
  incarnationId?: string
  state: SessionState
  shellState: ShellReadyState
  isAlive: boolean
  terminalHandle?: string
  wslDistro?: string | null
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

// Why: SessionInfo + source protocol version, so the Manage Sessions UI can
// label legacy-backed sessions. Populated by the router/adapter at RPC time;
// never transmitted over the daemon wire (daemon only speaks its own
// protocol version and doesn't know about other versions).
export type DaemonSessionInfo = SessionInfo & {
  protocolVersion: number
}
