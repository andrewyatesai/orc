// Error classes shared across the daemon protocol boundary (client, server,
// host). Split from types.ts, which is capped for wire-shape declarations.
export class TerminalAttachCanceledError extends Error {
  constructor(sessionId: string) {
    super(`Attach canceled for session ${sessionId}`)
    this.name = 'TerminalAttachCanceledError'
  }
}

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonProtocolError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

// Message is the stable code the toast humanizes; carries no code field so RPC maps it to runtime_error.
export class TerminalHostGoneError extends Error {
  constructor() {
    super('terminal_host_gone')
    this.name = 'TerminalHostGoneError'
  }
}

// Connect ENOENT/ECONNREFUSED proves the endpoint is absent; open ENOENT can be a missing token file,
// so scope to syscall='connect'. Narrower than isDaemonGoneError (that also respawns on transients).
export function isDaemonEndpointGoneError(err: unknown): boolean {
  const candidate = err as { code?: unknown; syscall?: unknown } | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.syscall === 'connect' &&
    (candidate.code === 'ENOENT' || candidate.code === 'ECONNREFUSED')
  )
}
