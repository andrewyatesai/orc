import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import {
  runMacosLoginSessionPtyProbe,
  type LoginPreflightOutcome
} from './macos-login-session-pty-probe'
import {
  fromLoginPreflightOutcome,
  runLoginPreflight,
  toLoginPreflightOutcome,
  verifyRejectedLoginPreflightUnderPty,
  LOGIN_PREFLIGHT_MAX_BUFFER_BYTES,
  MACOS_LOGIN_PATH,
  type LoginPreflightAttempt,
  type MacosTccLoginPreflightReason,
  type MacosTccLoginPreflightResult
} from './macos-login-pam-preflight-probe'

export type { LoginPreflightOutcome } from './macos-login-session-pty-probe'
export type {
  MacosTccLoginPreflightReason,
  MacosTccLoginPreflightResult
} from './macos-login-pam-preflight-probe'

const MACOS_BASH_PATH = '/bin/bash'
// Why: restore SHELL that login(1) overwrites, then exec the configured shell in-place.
const LOGIN_SHELL_TRAMPOLINE = 'export SHELL="$1"; shift; exec -l -- "$@"'
const DIRECT_SHELL_TRAMPOLINE = 'export SHELL="$1"; shift; exec -- "$@"'
// Why: the death-watch probe runs off the spawn path, so it can afford a bound
// that outlasts a PAM stack answering slowly rather than misreading it as a hang.
const LOGIN_SESSION_WATCH_PROBE_TIMEOUT_MS = 4_000
const LOGIN_PREFLIGHT_RETRY_BASE_MS = 5_000
const LOGIN_PREFLIGHT_RETRY_MAX_MS = 5 * 60_000
// Why: daemons live for weeks across app updates, so a rejected verdict must not
// disable TCC attribution forever; re-verify on a slow cadence (#9756).
const LOGIN_PREFLIGHT_REJECTED_REVALIDATE_MS = 30 * 60_000

/**
 * Env escape hatch to force the plain (unwrapped) spawn. Set to `1`/`true` if a
 * user's environment misbehaves under login(1); terminals fall back to today's
 * direct-spawn behavior.
 */
const DISABLE_ENV_VAR = 'ORCA_DISABLE_MACOS_LOGIN_SHELL'

type TransientLoginPreflightFailure = {
  failureCount: number
  reason: MacosTccLoginPreflightReason
  retryAtMs: number
}

let cachedLoginPreflightResult: MacosTccLoginPreflightResult | null = null
let cachedRejectionAtMs: number | null = null
let transientLoginPreflightFailure: TransientLoginPreflightFailure | null = null
let loginPreflightInFlight: Promise<MacosTccLoginPreflightResult> | null = null
let loginPreflightCacheEpoch = 0
let loginSessionProbeInFlight = false
let loginSessionAcceptedInProcess = false

function isDisabledByEnv(): boolean {
  const value = process.env[DISABLE_ENV_VAR]
  return value === '1' || value === 'true'
}

function retryDelayMs(failureCount: number): number {
  return Math.min(
    LOGIN_PREFLIGHT_RETRY_MAX_MS,
    LOGIN_PREFLIGHT_RETRY_BASE_MS * 2 ** Math.max(0, failureCount - 1)
  )
}

function expireStaleRejectedVerdict(): void {
  if (
    cachedLoginPreflightResult &&
    !cachedLoginPreflightResult.enabled &&
    cachedRejectionAtMs !== null &&
    Date.now() - cachedRejectionAtMs >= LOGIN_PREFLIGHT_REJECTED_REVALIDATE_MS
  ) {
    cachedLoginPreflightResult = null
    cachedRejectionAtMs = null
  }
}

function cacheConclusiveLoginPreflightResult(result: LoginPreflightAttempt): void {
  if (result.enabled) {
    cachedRejectionAtMs = null
    loginSessionAcceptedInProcess = true
  } else if (
    !cachedLoginPreflightResult ||
    cachedLoginPreflightResult.enabled ||
    cachedRejectionAtMs === null
  ) {
    // Why: periodic health probes must not extend one rejected verdict forever.
    cachedRejectionAtMs = Date.now()
  }
  cachedLoginPreflightResult = result
  transientLoginPreflightFailure = null
}

function getLoginPreflightResult(
  username: string,
  accountHome: string,
  report?: (result: MacosTccLoginPreflightResult) => void
): Promise<MacosTccLoginPreflightResult> {
  if (cachedLoginPreflightResult) {
    return Promise.resolve(cachedLoginPreflightResult)
  }

  const now = Date.now()
  if (transientLoginPreflightFailure && now < transientLoginPreflightFailure.retryAtMs) {
    return Promise.resolve({
      enabled: false,
      reason: transientLoginPreflightFailure.reason,
      retryable: true,
      retryAfterMs: transientLoginPreflightFailure.retryAtMs - now
    })
  }

  if (!loginPreflightInFlight) {
    const cacheEpoch = loginPreflightCacheEpoch
    // Why: simultaneous pane restores share one PAM child instead of multiplying
    // subprocesses at exactly the point terminal startup is already busiest.
    loginPreflightInFlight = runLoginPreflight(username, accountHome)
      .then(async (pipeAttempt) => {
        const attempt = await verifyRejectedLoginPreflightUnderPty(
          username,
          accountHome,
          pipeAttempt
        )
        // Why: a fresh death-watch probe can land a newer verdict while this one is
        // in flight; the older spawn-path result must never restore the stale one.
        const mayUpdateCache = !loginSessionProbeInFlight && cacheEpoch === loginPreflightCacheEpoch
        let result: MacosTccLoginPreflightResult = attempt
        if (!attempt.retryable) {
          if (mayUpdateCache) {
            cacheConclusiveLoginPreflightResult(attempt)
          }
        } else if (mayUpdateCache) {
          const failureCount = (transientLoginPreflightFailure?.failureCount ?? 0) + 1
          const delayMs = retryDelayMs(failureCount)
          transientLoginPreflightFailure = {
            failureCount,
            reason: attempt.reason,
            retryAtMs: Date.now() + delayMs
          }
          result = { ...attempt, retryAfterMs: delayMs }
        }

        try {
          report?.(result)
        } catch {
          // Diagnostics must never affect whether a user's shell can spawn.
        }
        if (!report && !result.enabled) {
          console.warn(`[pty] macOS login(1) preflight ${result.reason}; spawning shells directly`)
        }
        return result
      })
      .finally(() => {
        // Why: release the in-flight slot so a retryable probe re-runs on the next
        // spawn instead of pinning every terminal to the degraded outcome.
        loginPreflightInFlight = null
      })
  }
  return loginPreflightInFlight
}

/**
 * Resolves the PAM capability check before a fresh PTY is spawned. Callers
 * await this at their async request boundary (#8985: the daemon adapter spawn
 * boundary included) so existing terminals stay responsive while login(1) runs.
 * Deterministic outcomes are cached; environmental failures retry with backoff
 * (#9404), and a cached rejection is re-verified after
 * {@link LOGIN_PREFLIGHT_REJECTED_REVALIDATE_MS} (#9756).
 *
 * `report` receives the full fork taxonomy for one actual attempt. The return
 * value carries the probe outcome when a probe ran this call, and `null` when the
 * call short-circuited (non-macOS, disabled, cached, backing off, no login
 * binary) — detached daemons destroy stderr, so a host that never surfaces the
 * console.warn above can still record a structured degrade (F2).
 */
export async function prepareMacosTccLoginShell(
  report?: (result: MacosTccLoginPreflightResult) => void
): Promise<LoginPreflightOutcome | null> {
  if (process.platform !== 'darwin' || isDisabledByEnv()) {
    return null
  }
  expireStaleRejectedVerdict()
  if (cachedLoginPreflightResult) {
    return null
  }
  // Why: a persistently hung probe must not add 500 ms and a subprocess to every terminal spawn.
  if (transientLoginPreflightFailure && Date.now() < transientLoginPreflightFailure.retryAtMs) {
    return null
  }
  if (!existsSync(MACOS_LOGIN_PATH)) {
    return null
  }

  let username: string
  let accountHome: string
  try {
    const account = userInfo()
    username = account.username
    accountHome = account.homedir
  } catch {
    return null
  }
  if (!username || !accountHome) {
    return null
  }
  return toLoginPreflightOutcome(await getLoginPreflightResult(username, accountHome, report))
}

export function resetMacosLoginShellPreflightForTests(): void {
  cachedLoginPreflightResult = null
  cachedRejectionAtMs = null
  transientLoginPreflightFailure = null
  loginPreflightInFlight = null
  loginPreflightCacheEpoch = 0
  loginSessionProbeInFlight = false
  loginSessionAcceptedInProcess = false
}

/**
 * Fresh PAM probe for login-session death detection (#7936): bypasses the
 * cached verdict and the transient backoff, and writes any conclusive verdict
 * back into the cache — so a daemon whose login session died stops wrapping
 * spawns in `login(1)` (which would only mint "Login incorrect" zombies) even
 * before retirement completes. Escalates ambiguous probes—and negative probes
 * after this process accepted a login session—to the production-shaped PTY
 * oracle. Returns null when the wrapper doesn't apply.
 */
export async function probeMacosLoginSessionAlive(
  signal?: AbortSignal
): Promise<LoginPreflightOutcome | null> {
  if (process.platform !== 'darwin' || isDisabledByEnv() || !existsSync(MACOS_LOGIN_PATH)) {
    return null
  }
  let username: string
  let accountHome: string
  try {
    const account = userInfo()
    username = account.username
    accountHome = account.homedir
  } catch {
    return null
  }
  if (!username || !accountHome) {
    return null
  }
  // Why: reuse the startup warmup when present, and fence older spawn-path results from restoring a stale verdict.
  const existingPreflight = loginPreflightInFlight
  loginSessionProbeInFlight = true
  loginPreflightCacheEpoch++
  let outcome: LoginPreflightOutcome
  try {
    outcome = toLoginPreflightOutcome(
      await (existingPreflight ??
        runLoginPreflight(username, accountHome, LOGIN_SESSION_WATCH_PROBE_TIMEOUT_MS, signal))
    )
    if (!outcome.ok && !signal?.aborted && (!outcome.conclusive || loginSessionAcceptedInProcess)) {
      outcome = await runMacosLoginSessionPtyProbe(
        username,
        accountHome,
        LOGIN_SESSION_WATCH_PROBE_TIMEOUT_MS,
        LOGIN_PREFLIGHT_MAX_BUFFER_BYTES,
        signal
      )
    }
  } finally {
    // Why: invalidate spawn probes started during this fresh check before they can overwrite its newer verdict.
    loginPreflightCacheEpoch++
    loginSessionProbeInFlight = false
  }
  if (outcome.conclusive) {
    cacheConclusiveLoginPreflightResult(fromLoginPreflightOutcome(outcome))
  }
  return outcome
}

/**
 * Wrap a macOS shell spawn in `/usr/bin/login -flpq <user> …` so terminal children
 * get their own TCC identity instead of collapsing into Orca's bundle id — signed
 * CLIs like `op` otherwise re-prompt every launch because tccd attributes the grant
 * to Orca and never persists it (#6996, #8985).
 *
 * A clean bash trampoline restores SHELL after login(1) overwrites it, then replaces
 * itself with the configured shell. Values stay positional so custom paths and
 * arguments are never interpreted as shell source.
 *
 * No-op off macOS, when already wrapped, when disabled via {@link DISABLE_ENV_VAR},
 * or when the login(1) PAM preflight rejected this process's user.
 */
export function wrapShellSpawnForMacosTccAttribution(
  file: string,
  args: string[],
  env?: Record<string, string | undefined>
): { file: string; args: string[] } {
  if (process.platform !== 'darwin') {
    return { file, args }
  }
  if (file === MACOS_LOGIN_PATH || isDisabledByEnv()) {
    return { file, args }
  }
  if (!existsSync(MACOS_LOGIN_PATH)) {
    return { file, args }
  }

  let username: string
  try {
    username = userInfo().username
  } catch {
    return { file, args }
  }
  if (!username) {
    return { file, args }
  }
  // Why: fork divergence from upstream — a boundary that never awaited the
  // preflight keeps today's wrap (never fail-open, which is how #8985's
  // per-launch TCC prompts appeared upstream); only a preflight that actually
  // ran and failed (PAM reject, or a transient failure pending its #9404
  // retry) downgrades to a direct shell.
  if (
    cachedLoginPreflightResult
      ? !cachedLoginPreflightResult.enabled
      : transientLoginPreflightFailure !== null
  ) {
    return { file, args }
  }

  const shellEnvValue = env?.SHELL || file
  // Why: Bash ignores --rcfile when argv[0] marks it as a login shell; Orca's
  // rcfile already reproduces login startup and must remain the active wrapper.
  const trampoline =
    basename(file).toLowerCase() === 'bash' && args.includes('--rcfile')
      ? DIRECT_SHELL_TRAMPOLINE
      : LOGIN_SHELL_TRAMPOLINE

  // Why: -p blocks login(1)-preserved BASH_ENV and imported functions before the fixed trampoline runs.
  return {
    file: MACOS_LOGIN_PATH,
    args: [
      '-flpq',
      username,
      MACOS_BASH_PATH,
      '--noprofile',
      '--norc',
      '-p',
      '-c',
      trampoline,
      'orca-tcc-login',
      shellEnvValue,
      file,
      ...args
    ]
  }
}
