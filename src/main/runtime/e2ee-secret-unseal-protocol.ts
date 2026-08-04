/**
 * Wire contract between the runtime and the disposable child that performs the OS-keychain
 * half of the mobile E2EE identity. Kept in its own module so the child entry never pulls
 * `node:child_process` (the host) into its graph, and the host never pulls `electron`.
 */

/** Set on the child so the shared bundle entry dispatches to the helper instead of the app. */
export const E2EE_SECRET_HELPER_ENV_FLAG = 'ORCA_E2EE_SECRET_HELPER'

/** Delimits the reply from any Electron/GPU chatter sharing the child's stdout. */
export const E2EE_SECRET_HELPER_RESULT_PREFIX = '__orca_e2ee_secret__'

export type E2EESecretHelperRequest =
  | { op: 'unseal'; ciphertextB64: string }
  | { op: 'seal'; secretKeyB64: string }

/** What the child itself can report; the host adds the failures only it can observe (timeout, spawn). */
export type E2EESecretHelperReply =
  | { ok: true; op: 'unseal'; secretKeyB64: string }
  | { ok: true; op: 'seal'; ciphertextB64: string }
  | { ok: false; reason: 'encryption_unavailable' | 'keychain_error'; message: string }

export function encodeE2EESecretHelperReply(reply: E2EESecretHelperReply): string {
  return `${E2EE_SECRET_HELPER_RESULT_PREFIX}${JSON.stringify(reply)}\n`
}

export function decodeE2EESecretHelperReply(stdout: string): E2EESecretHelperReply | null {
  const marker = stdout.lastIndexOf(E2EE_SECRET_HELPER_RESULT_PREFIX)
  if (marker < 0) {
    return null
  }
  const start = marker + E2EE_SECRET_HELPER_RESULT_PREFIX.length
  const end = stdout.indexOf('\n', start)
  if (end < 0) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end))
    return isReply(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isReply(value: unknown): value is E2EESecretHelperReply {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.ok === true) {
    return record.op === 'unseal'
      ? typeof record.secretKeyB64 === 'string'
      : record.op === 'seal' && typeof record.ciphertextB64 === 'string'
  }
  return (
    record.ok === false &&
    (record.reason === 'encryption_unavailable' || record.reason === 'keychain_error') &&
    typeof record.message === 'string'
  )
}
