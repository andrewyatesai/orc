// Why: the SSH relay shim (`~/.orca-relay/bin/orca`) forwards CLI invocations
// to the host app. Instead of re-implementing every command in a hand-rolled
// switch (the cause of "Unsupported SSH Orca CLI command", #7716), the host
// runs the real bundled `orca` CLI entry in Electron node mode — the same
// entry the local shell command uses — so remote invocations get the full
// command surface (orchestration, worktree, terminal, ...) by construction.
import { app } from 'electron'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence'
import {
  createScopedCallerMetadataDir,
  resolveRemoteCallerScope,
  type ScopedCallerMetadata
} from './ssh-remote-cli-caller-scope'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { clampOrchestrationAskTimeoutMs } from '../../shared/orchestration-ask-timeout'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import {
  parseRemoteCliCallerIdentity,
  withRemoteCliIdentityEnv,
  type RemoteCliCallerIdentity
} from '../../shared/ssh-remote-cli-identity'
import {
  MAX_TIMER_DELAY_MS,
  isSafeTimerDelayMs,
  parsePositiveSafeIntegerNumericText,
  parsePositiveSafeIntegerText
} from '../../shared/timer-delay'

export type RemoteOrcaCliRequest = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  /** Pane the relay attributed the call to. Absent means "no pane identity". */
  identity?: RemoteCliCallerIdentity
  stdin?: string
  /**
   * SSH target the call arrived over — the session's own id, never anything the
   * remote side can state. Absent means the call cannot be attributed to a host
   * and must reach nothing.
   */
  connectionId?: string
}

export type RemoteOrcaCliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type HostCliPassthroughOptions = {
  execPath?: string
  cliEntryPath?: string
  userDataPath?: string
  hostEnv?: NodeJS.ProcessEnv
  spawn?: typeof nodeSpawn
  entryExists?: (path: string) => boolean
  killTimeoutMs?: number
  /** Test seam: mints the scoped runtime metadata the CLI subprocess authenticates with. */
  createScopedCallerMetadata?: typeof createScopedCallerMetadataDir
}

/** Thrown when the host CLI entry cannot be launched at all; callers fall back
 * to the legacy in-process command switch so previously-working commands keep
 * working even on broken installs. */
export class HostCliUnavailableError extends Error {}

/**
 * Narrows untrusted `orca.cli` params into a host CLI request.
 *
 * Why identity is re-imposed on `env` here rather than trusted to have been
 * stripped upstream: the legacy in-process fallback reads pane context out of
 * `env`, and the relay that sanitized the payload runs on the remote machine.
 * The host decides what its own CLI sees.
 */
export function parseRemoteOrcaCliRequest(params: Record<string, unknown>): RemoteOrcaCliRequest {
  const argv = Array.isArray(params.argv)
    ? params.argv.filter((item): item is string => typeof item === 'string')
    : []
  const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : '/'
  const rawEnv = params.env
  const env =
    rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
      ? Object.fromEntries(
          Object.entries(rawEnv).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === 'string' && typeof entry[1] === 'string'
          )
        )
      : {}
  const identity = parseRemoteCliCallerIdentity(params.identity)
  const stdin = typeof params.stdin === 'string' ? params.stdin : undefined
  return {
    argv,
    cwd,
    env: withRemoteCliIdentityEnv(env, identity),
    identity,
    ...(stdin !== undefined ? { stdin } : {})
  }
}

// Why: nothing from the remote shell crosses into the host CLI process. Remote
// PATH / ORCA_USER_DATA_PATH are paths on the remote machine (meaningless or
// instance-hijacking on the host), NODE_OPTIONS-style vars could alter host
// execution, and the Orca terminal-context vars are pane authority — those come
// from the relay's attribution of the calling PTY instead.

// Why: with no attributed pane there is no directory this call may speak for,
// and `--worktree active` resolves ORCA_CLI_CWD against every worktree the host
// knows — remote and local in one namespace. The filesystem root is contained by
// no managed worktree, so the selector fails loudly instead of quietly landing
// on a checkout on the user's own machine.
const UNATTRIBUTED_CLI_CWD = '/'

// Why: bound captured output so a runaway command cannot balloon the relay
// JSON-RPC response or main-process memory.
const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_KILL_TIMEOUT_MS = 10 * 60_000
const KILL_TIMEOUT_GRACE_MS = 2 * 60_000

export function resolveHostCliEntryPath(app: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  // Why: mirrors the packaged launcher scripts (resources/*/bin) and the dev
  // launcher in cli-installer.ts — packaged builds ship the CLI entry outside
  // app.asar so Electron node mode can execute it directly.
  return app.isPackaged
    ? join(app.resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
    : join(app.appPath, 'out', 'cli', 'index.js')
}

/** Kill timer for the host CLI subprocess. Long-poll commands carry their wait
 * budget in `--timeout-ms`; extend past it so the CLI's own timeout fires
 * first and produces a proper error message. */
export function resolveHostCliKillTimeoutMs(argv: string[]): number {
  const parsed = parseRemoteCliArgs(argv)
  const rawTimeout = parsed.flags.get('timeout-ms')
  if (parsed.commandPath[0] === 'orchestration' && parsed.commandPath[1] === 'ask') {
    const explicit =
      typeof rawTimeout === 'string' ? parsePositiveSafeIntegerText(rawTimeout) : null
    return Math.max(
      DEFAULT_KILL_TIMEOUT_MS,
      clampOrchestrationAskTimeoutMs(explicit ?? undefined) + KILL_TIMEOUT_GRACE_MS
    )
  }
  const explicit =
    typeof rawTimeout === 'string' ? parsePositiveSafeIntegerNumericText(rawTimeout) : null
  // Why: this feeds the kill timer directly, so a post-grace budget outside the
  // timer range degrades to the default instead of throwing at spawn time.
  const extended = explicit === null ? null : explicit + KILL_TIMEOUT_GRACE_MS
  if (extended !== null && isSafeTimerDelayMs(extended)) {
    return Math.max(DEFAULT_KILL_TIMEOUT_MS, extended)
  }
  return DEFAULT_KILL_TIMEOUT_MS
}

/**
 * Caller directory the host CLI may resolve `--worktree active` against.
 *
 * The remote cwd is remote-chosen text, and it is compared against host worktree
 * records that hold remote and local paths alike — so an unconstrained value can
 * select a checkout the caller never had. Honor it only inside the attributed
 * pane's own worktree; otherwise fall back to that worktree, which is the pane
 * the call demonstrably belongs to.
 */
export function resolveHostCliCallerCwd(
  remoteCwd: string,
  identity: RemoteCliCallerIdentity
): string {
  const worktreePath = identity.worktreeId
    ? splitWorktreeIdForFilesystem(identity.worktreeId)?.worktreePath
    : undefined
  if (!worktreePath) {
    return UNATTRIBUTED_CLI_CWD
  }
  if (remoteCwd.length === 0) {
    return worktreePath
  }
  // Why: collapse `..` before deciding — the containment check is textual while
  // the CLI resolves the path it receives, so an uncollapsed `wt/../../elsewhere`
  // would pass here and escape there.
  const resolvedCwd = resolveRuntimePath(worktreePath, remoteCwd)
  if (!isPathInsideOrEqual(worktreePath, resolvedCwd)) {
    return worktreePath
  }
  // Why: keep the caller's own spelling (Windows separators) when resolving
  // changed nothing; forward the collapsed form only when it had to.
  return normalizeRuntimePathForComparison(remoteCwd) ===
    normalizeRuntimePathForComparison(resolvedCwd)
    ? remoteCwd
    : resolvedCwd
}

export function buildHostCliEnv(args: {
  hostEnv: NodeJS.ProcessEnv
  identity: RemoteCliCallerIdentity
  userDataPath: string
  remoteCwd: string
}): NodeJS.ProcessEnv {
  // Why: clears the identity vars before setting them, so a value this app
  // process inherited (Orca launched from an Orca pane) cannot stand in for a
  // pane the relay could not attribute.
  const env: NodeJS.ProcessEnv = withRemoteCliIdentityEnv({ ...args.hostEnv }, args.identity)
  // Why: bind the subprocess to this app instance's runtime metadata (dev and
  // parallel instances use non-default userData dirs).
  env.ORCA_USER_DATA_PATH = args.userDataPath
  // Why: the caller's working directory lives on the remote machine, so the
  // subprocess cwd cannot be chdir'd there; ORCA_CLI_CWD carries it for
  // cwd-based selectors like `--worktree active`.
  env.ORCA_CLI_CWD = resolveHostCliCallerCwd(args.remoteCwd, args.identity)
  // Why: same node-mode hygiene as the shipped CLI launchers — stash and clear
  // NODE_OPTIONS so Electron's node bootstrap does not inherit them.
  env.ORCA_NODE_OPTIONS = args.hostEnv.NODE_OPTIONS ?? ''
  env.ORCA_NODE_REPL_EXTERNAL_MODULE = args.hostEnv.NODE_REPL_EXTERNAL_MODULE ?? ''
  delete env.NODE_OPTIONS
  delete env.NODE_REPL_EXTERNAL_MODULE
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export async function runHostOrcaCliPassthrough(
  request: RemoteOrcaCliRequest,
  options: HostCliPassthroughOptions = {}
): Promise<RemoteOrcaCliResult> {
  // Why: per-field lazy defaults keep the module testable — tests inject all
  // three, so no Electron API is touched outside the production path.
  const execPath = options.execPath ?? process.execPath
  let cliEntryPath: string
  let userDataPath: string
  try {
    cliEntryPath =
      options.cliEntryPath ??
      resolveHostCliEntryPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      })
    // Why: must match the userData dir the runtime RPC server writes metadata
    // to (see index.ts OrcaRuntimeRpcServer wiring), or the CLI subprocess
    // reports "Orca is not running" against a healthy app.
    userDataPath = options.userDataPath ?? getCanonicalUserDataPath()
  } catch (err) {
    // Why: no Electron app context (or broken install paths) — degrade to the
    // caller's legacy in-process fallback instead of failing the command.
    throw new HostCliUnavailableError(
      `Host CLI environment unavailable: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const hostEnv = options.hostEnv ?? process.env
  const spawn = options.spawn ?? nodeSpawn
  const entryExists = options.entryExists ?? existsSync
  const killTimeoutMs = options.killTimeoutMs ?? resolveHostCliKillTimeoutMs(request.argv)
  if (!isSafeTimerDelayMs(killTimeoutMs)) {
    throw new RangeError(
      `Host CLI kill timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }

  if (!entryExists(cliEntryPath)) {
    throw new HostCliUnavailableError(`Orca CLI entry not found at ${cliEntryPath}`)
  }

  // Why: fail closed — if the subprocess cannot be given a scoped token it would
  // authenticate with the shared one and run unbounded, so hand the caller its
  // in-process fallback (which carries the scope directly) instead.
  let scopedMetadata: ScopedCallerMetadata
  try {
    scopedMetadata = (options.createScopedCallerMetadata ?? createScopedCallerMetadataDir)(
      resolveRemoteCallerScope(request),
      userDataPath
    )
  } catch (err) {
    throw new HostCliUnavailableError(
      `Could not scope the Orca CLI bridge to its caller: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const env = buildHostCliEnv({
    hostEnv,
    identity: request.identity ?? {},
    userDataPath: scopedMetadata.userDataPath,
    remoteCwd: request.cwd
  })

  try {
    return await runChild()
  } finally {
    // Why: a single-use credential that outlives its invocation is a standing key.
    scopedMetadata.dispose()
  }

  async function runChild(): Promise<RemoteOrcaCliResult> {
    return await new Promise<RemoteOrcaCliResult>((resolve, reject) => {
      let settled = false
      const child = spawn(execPath, [cliEntryPath, ...request.argv], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      const stdout = new CappedOutputCollector(MAX_CAPTURED_OUTPUT_BYTES)
      const stderr = new CappedOutputCollector(MAX_CAPTURED_OUTPUT_BYTES)

      const killTimer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        try {
          child.kill('SIGKILL')
        } catch {
          // best effort — process may already be gone
        }
        resolve({
          stdout: stdout.toString(),
          stderr: `${stderr.toString()}Orca CLI bridge timed out after ${killTimeoutMs}ms on the host.\n`,
          exitCode: 1
        })
      }, killTimeoutMs)
      killTimer.unref?.()

      child.on('error', (err) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(killTimer)
        // Why: failure to launch (ENOENT, EACCES) means the host CLI is not
        // runnable at all — signal the caller to use the legacy fallback rather
        // than reporting a confusing per-command failure.
        reject(
          new HostCliUnavailableError(`Failed to launch the Orca CLI on the host: ${err.message}`)
        )
      })

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

      child.on('close', (code) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(killTimer)
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: typeof code === 'number' ? code : 1
        })
      })

      if (child.stdin) {
        child.stdin.on('error', () => {
          // Why: the CLI may exit without draining stdin; EPIPE here is routine.
        })
        if (request.stdin !== undefined) {
          child.stdin.end(request.stdin)
        } else {
          child.stdin.end()
        }
      }
    })
  }
}

class CappedOutputCollector {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) {
      return
    }
    const remaining = this.maxBytes - this.bytes
    if (chunk.length >= remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.bytes = this.maxBytes
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf8')
    return this.truncated ? `${text}\n[orca ssh cli] output truncated\n` : text
  }
}
