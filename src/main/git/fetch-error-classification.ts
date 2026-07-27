import { isExecKilledError } from '../../shared/git-remote-error'
import { requireRustGitBinding } from '../daemon/rust-git-addon'

// Why: execFile rejections carry `Command failed: git fetch …` in `.message`
// while git's real `fatal: …` diagnostic lives in `.stderr`; classify on both
// or multi-remote PR resolution treats a missing ref as a hard failure and
// never walks the next remote.
function fetchErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const stderr =
    error && typeof error === 'object' && typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : ''
  return `${message}\n${stderr}`
}

/** True when a git fetch/pull error means the remote ref does not exist (an
 *  expected state, not a failure). The matching runs in the Rust `orca-git`
 *  core (fetch_error_classification.rs — the TS body was deleted); only the
 *  `unknown`→message extraction stays at this JS boundary. */
export function isMissingRemoteRefGitError(error: unknown): boolean {
  return requireRustGitBinding().isMissingRemoteRefGitError(fetchErrorText(error))
}

// Why: allowlist, not blocklist — soft-keeping a durable review-head ref is
// only safe when the fetch plainly died in transport. A deleted PR head, auth
// failure, or stale-relay method-not-found must surface, or the caller checks
// out a dead/unauthorized tip. Covers raw git stderr and the relay's
// normalized messages ("Network error. Check your connection.", "… timed out").
const TRANSIENT_FETCH_ERROR_PATTERNS = [
  'timed out',
  'timeout',
  'operation was aborted',
  'network error',
  'network is unreachable',
  'could not resolve host',
  'temporary failure in name resolution',
  'connection refused',
  'connection reset',
  'connection closed',
  'early eof',
  'remote end hung up',
  'the requested url returned error: 5'
]

export function isTransientReviewHeadFetchError(error: unknown): boolean {
  if (isMissingRemoteRefGitError(error)) {
    return false
  }
  if (isExecKilledError(error)) {
    return true
  }
  const normalized = fetchErrorText(error).toLowerCase()
  return TRANSIENT_FETCH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))
}
