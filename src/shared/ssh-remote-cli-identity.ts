// Pane identity carried on an SSH `orca.cli` call.
//
// Why this is a separate contract instead of "some env vars": on the host these
// four variables ARE authority. ORCA_PANE_KEY selects which pane a command acts
// as, ORCA_WORKTREE_ID which checkout it belongs to. A remote pane's environment
// is readable and writable by the remote account, so the call's payload can
// claim any of them. The only trustworthy source is the relay's attribution of
// the PTY the call actually came from, which travels in its own `identity`
// field — never mixed back into the caller-supplied env.

export type RemoteCliCallerIdentity = {
  paneKey?: string
  worktreeId?: string
  terminalHandle?: string
  workspaceId?: string
}

const IDENTITY_ENV_BY_FIELD = {
  paneKey: 'ORCA_PANE_KEY',
  worktreeId: 'ORCA_WORKTREE_ID',
  terminalHandle: 'ORCA_TERMINAL_HANDLE',
  workspaceId: 'ORCA_WORKSPACE_ID'
} as const satisfies Record<keyof RemoteCliCallerIdentity, string>

const IDENTITY_FIELDS = Object.keys(IDENTITY_ENV_BY_FIELD) as (keyof RemoteCliCallerIdentity)[]

/** The env vars that carry pane authority; nothing may set them from a payload. */
export const REMOTE_CLI_IDENTITY_ENV_VARS = IDENTITY_FIELDS.map(
  (field) => IDENTITY_ENV_BY_FIELD[field]
)

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Reads a pane's identity out of the env the relay spawned that pane with. */
export function remoteCliCallerIdentityFromPaneEnv(
  env: Record<string, string | undefined>
): RemoteCliCallerIdentity {
  const identity: RemoteCliCallerIdentity = {}
  for (const field of IDENTITY_FIELDS) {
    const value = nonEmptyString(env[IDENTITY_ENV_BY_FIELD[field]])
    if (value !== undefined) {
      identity[field] = value
    }
  }
  return identity
}

/** Narrows a wire-supplied `identity` field; unknown keys and non-strings drop. */
export function parseRemoteCliCallerIdentity(value: unknown): RemoteCliCallerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const source = value as Record<string, unknown>
  const identity: RemoteCliCallerIdentity = {}
  for (const field of IDENTITY_FIELDS) {
    const parsed = nonEmptyString(source[field])
    if (parsed !== undefined) {
      identity[field] = parsed
    }
  }
  return identity
}

/**
 * Copy of `env` whose identity vars come from `identity` alone: whatever the
 * input carried is dropped first, so an inherited or forged value cannot
 * survive by simply being absent from the attributed identity.
 */
export function withRemoteCliIdentityEnv<T extends Record<string, string | undefined>>(
  env: T,
  identity: RemoteCliCallerIdentity
): T {
  const result = { ...env }
  for (const key of REMOTE_CLI_IDENTITY_ENV_VARS) {
    delete result[key]
  }
  for (const field of IDENTITY_FIELDS) {
    const value = identity[field]
    if (value !== undefined) {
      ;(result as Record<string, string>)[IDENTITY_ENV_BY_FIELD[field]] = value
    }
  }
  return result
}
