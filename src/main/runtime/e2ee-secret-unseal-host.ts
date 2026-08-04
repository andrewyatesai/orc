/**
 * Runs the keychain half of the mobile E2EE identity in a child Electron process and puts a HARD
 * bound on it. An in-process timeout is impossible: `safeStorage` is synchronous and a macOS ACL
 * miss parks the whole main thread in the keychain syscall, so no timer can ever fire. A separate
 * process can be SIGKILLed — that is the entire reason this module exists.
 */
import { spawn as spawnChildProcess, type SpawnOptions } from 'node:child_process'
import {
  decodeE2EESecretHelperReply,
  E2EE_SECRET_HELPER_ENV_FLAG,
  type E2EESecretHelperReply,
  type E2EESecretHelperRequest
} from './e2ee-secret-unseal-protocol'

export type E2EESecretHelperFailureReason =
  /** Killed: the OS keychain never answered. Transient — the identity on disk is still intact. */
  | 'timeout'
  /** No Electron child could be launched at all (no app object, spawn refused, no parsable reply). */
  | 'helper_unavailable'
  | 'encryption_unavailable'
  | 'keychain_error'

export type E2EESecretHelperResult =
  | Extract<E2EESecretHelperReply, { ok: true }>
  | { ok: false; reason: E2EESecretHelperFailureReason; message: string }

type SpawnHelper = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ReturnType<typeof spawnChildProcess>

export type E2EESecretHelperOptions = {
  timeoutMs?: number
  spawnHelper?: SpawnHelper
  resolveLaunch?: () => { command: string; args: string[] } | null
}

// Why: a matching-ACL unseal returns in milliseconds; anything near this is the wedge, not slowness.
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_STDOUT_BYTES = 64 * 1024

function failure(
  reason: E2EESecretHelperFailureReason,
  message: string
): Extract<E2EESecretHelperResult, { ok: false }> {
  return { ok: false, reason, message }
}

function loadElectronApp(): { getAppPath(): string; isPackaged: boolean } | null {
  try {
    // require, not import: under vitest's node runtime `electron` resolves to a path string.
    const app = require('electron')?.app
    return typeof app?.getAppPath === 'function' ? app : null
  } catch {
    return null
  }
}

function resolveElectronLaunch(): { command: string; args: string[] } | null {
  const app = loadElectronApp()
  if (!app) {
    return null
  }
  // Why: a packaged Electron binary has no default_app, so a script path in argv is ignored — the
  // child re-enters through the bundled bootstrap and dispatches on the env flag. A dev electron
  // binary would otherwise open the Electron welcome window, so it still needs the app path.
  return { command: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [E2EE_SECRET_HELPER_ENV_FLAG]: '1' }
  // Why: safeStorage does not exist under ELECTRON_RUN_AS_NODE; an inherited flag would silently
  // turn the helper into a plain Node process that can never answer.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export async function runE2EESecretHelper(
  request: E2EESecretHelperRequest,
  options: E2EESecretHelperOptions = {}
): Promise<E2EESecretHelperResult> {
  const launch = (options.resolveLaunch ?? resolveElectronLaunch)()
  if (!launch) {
    return failure('helper_unavailable', 'No Electron runtime is available to reach the keychain.')
  }
  const spawnHelper = options.spawnHelper ?? spawnChildProcess
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let child: ReturnType<SpawnHelper>
  try {
    child = spawnHelper(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: childEnvironment(),
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })
  } catch (error) {
    return failure(
      'helper_unavailable',
      error instanceof Error ? error.message : 'Failed to spawn the keychain helper.'
    )
  }

  return await new Promise<E2EESecretHelperResult>((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (result: E2EESecretHelperResult, kill: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (kill) {
        // SIGKILL, not SIGTERM: a process parked in the keychain syscall never runs a handler.
        child.kill('SIGKILL')
      }
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish(
          failure(
            'timeout',
            `The OS keychain did not answer within ${timeoutMs}ms; the helper was terminated.`
          ),
          true
        ),
      timeoutMs
    )
    timer.unref?.()

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += chunk
      }
      const reply = decodeE2EESecretHelperReply(stdout)
      if (reply) {
        finish(reply.ok ? reply : failure(reply.reason, reply.message), true)
      }
    })
    child.on('error', (error: Error) => finish(failure('helper_unavailable', error.message), false))
    child.on('close', () => {
      const reply = decodeE2EESecretHelperReply(stdout)
      finish(
        reply
          ? reply.ok
            ? reply
            : failure(reply.reason, reply.message)
          : failure('helper_unavailable', 'The keychain helper exited without a usable reply.'),
        false
      )
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(request))
  })
}
