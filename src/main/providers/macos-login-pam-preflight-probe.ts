import { execFile } from 'node:child_process'
import {
  runMacosLoginSessionPtyProbe,
  type LoginPreflightOutcome
} from './macos-login-session-pty-probe'

export const MACOS_LOGIN_PATH = '/usr/bin/login'
const MACOS_PRINTF_PATH = '/usr/bin/printf'
const LOGIN_PREFLIGHT_TIMEOUT_MS = 500
const LOGIN_PREFLIGHT_MARKER = 'ORCA_LOGIN_PREFLIGHT_OK'
export const LOGIN_PREFLIGHT_MAX_BUFFER_BYTES = 1024

export type MacosTccLoginPreflightReason =
  | 'supported'
  | 'pam-rejected'
  | 'timeout'
  | 'output-limit'
  | 'unexpected-output'
  | 'exec-error'

/**
 * One PAM probe verdict. `retryable: false` marks a real PAM answer (accept or
 * reject) that may be cached; a retryable outcome (our own timeout/SIGKILL,
 * maxBuffer, spawn error, ambiguous output) proves nothing and must not stick.
 */
export type MacosTccLoginPreflightResult = {
  enabled: boolean
  reason: MacosTccLoginPreflightReason
  retryable: boolean
  retryAfterMs?: number
}

export type LoginPreflightAttempt = Omit<MacosTccLoginPreflightResult, 'retryAfterMs'>

type LoginPreflightError = Error & {
  code?: string | number | null
  killed?: boolean
}

/** Fork taxonomy -> the outcome shape the daemon's login-session watch consumes. */
export function toLoginPreflightOutcome(result: LoginPreflightAttempt): LoginPreflightOutcome {
  if (result.enabled) {
    return { ok: true, conclusive: true, reason: 'accepted' }
  }
  if (!result.retryable) {
    return { ok: false, conclusive: true, reason: 'rejected' }
  }
  return { ok: false, conclusive: false, reason: result.reason === 'timeout' ? 'timeout' : 'error' }
}

/** Only ever called with a conclusive outcome, so the reason collapses to two. */
export function fromLoginPreflightOutcome(outcome: LoginPreflightOutcome): LoginPreflightAttempt {
  return outcome.ok
    ? { enabled: true, reason: 'supported', retryable: false }
    : { enabled: false, reason: 'pam-rejected', retryable: false }
}

function classifyLoginPreflight(
  error: LoginPreflightError | null,
  stdout: string
): LoginPreflightAttempt {
  // Why: the probe uses pipes while production uses a PTY. Treat ambiguous
  // output as retryable so a tty-sensitive PAM stack is never disabled forever.
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { enabled: false, reason: 'output-limit', retryable: true }
  }
  if (error?.code === 'ETIMEDOUT' || error?.killed) {
    return { enabled: false, reason: 'timeout', retryable: true }
  }
  if (!error && stdout === LOGIN_PREFLIGHT_MARKER) {
    return { enabled: true, reason: 'supported', retryable: false }
  }
  if (/Login incorrect|(?:^|\n)login:\s*/i.test(stdout)) {
    return { enabled: false, reason: 'pam-rejected', retryable: false }
  }
  // Why: a natural nonzero exit (numeric code, never a spawn errno string) is
  // login(1)'s own conclusive rejection verdict, not an environmental hiccup.
  if (typeof error?.code === 'number') {
    return { enabled: false, reason: 'pam-rejected', retryable: false }
  }
  if (error) {
    return { enabled: false, reason: 'exec-error', retryable: true }
  }
  return { enabled: false, reason: 'unexpected-output', retryable: true }
}

// Fidelity limit: this probe runs over pipes while production shells run under a
// real PTY, so a tty-sensitive PAM stack could diverge; conclusive rejections are
// re-checked against the PTY oracle before they are allowed to stick.
export function runLoginPreflight(
  username: string,
  accountHome: string,
  timeoutMs = LOGIN_PREFLIGHT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<LoginPreflightAttempt> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        MACOS_LOGIN_PATH,
        ['-flpq', username, MACOS_PRINTF_PATH, LOGIN_PREFLIGHT_MARKER],
        {
          // Why: detached daemons can outlive their launch worktree. The PAM
          // probe must not inherit a deleted cwd before PTY spawn repairs it.
          cwd: accountHome,
          encoding: 'utf8',
          // Why: PAM policy can wait indefinitely. Bound both child lifetime and
          // captured diagnostics without blocking the PTY host's event loop.
          killSignal: 'SIGKILL',
          maxBuffer: LOGIN_PREFLIGHT_MAX_BUFFER_BYTES,
          signal,
          timeout: timeoutMs
        },
        (error, stdout) => {
          // login(1) can return zero after an EOF-driven failed prompt, so only the
          // requested child program's output plus a clean exit proves PAM accepted it.
          resolve(classifyLoginPreflight(error, stdout))
        }
      )
      // Why: login(1) must see immediate EOF, not an interactive pipe, so a PAM
      // rejection exits instead of waiting at `login:` until the timeout.
      child.stdin?.end()
    } catch (error) {
      resolve(classifyLoginPreflight(error as LoginPreflightError, ''))
    }
  })
}

/** A pipe-sensitive PAM stack must not disable attribution on its own authority. */
export async function verifyRejectedLoginPreflightUnderPty(
  username: string,
  accountHome: string,
  attempt: LoginPreflightAttempt
): Promise<LoginPreflightAttempt> {
  // Why escalate 'unexpected-output' too: a clean exit whose stdout is not the
  // marker is what upstream files as a rejection, and it is exactly the shape a
  // tty-sensitive PAM stack produces behind a pipe. Without the oracle the retry
  // loop re-runs the same pipe probe forever and attribution stays off (#6996).
  if (attempt.enabled || (attempt.retryable && attempt.reason !== 'unexpected-output')) {
    return attempt
  }
  const ptyOutcome = await runMacosLoginSessionPtyProbe(
    username,
    accountHome,
    LOGIN_PREFLIGHT_TIMEOUT_MS,
    LOGIN_PREFLIGHT_MAX_BUFFER_BYTES
  )
  // Why: the production-shaped PTY oracle wins, but only when it actually decided.
  return ptyOutcome.conclusive ? fromLoginPreflightOutcome(ptyOutcome) : attempt
}
