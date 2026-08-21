import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)

export type PreflightWslCommandResult = { stdout: string; stderr: string }

export async function runPreflightCommandInWsl(
  target: WslPreflightTarget,
  command: string,
  timeoutMs: number
): Promise<PreflightWslCommandResult> {
  // Why the fence: callers match this stdout against version and auth-status
  // patterns, and the interactive login shell prints the distro rc banner (stock
  // Ubuntu's sudo hint) ahead of the real output, making a working CLI look
  // missing. Strip to the payload; keep the raw result when the fence is absent
  // since these matchers scan the whole blob and tolerate a prefix.
  const captured = buildWslCapturedLoginShellCommand(command)
  const result = (await execFileAsync(
    'wsl.exe',
    buildWslExecArgs(target.distro, ['sh', '-c', captured.command]),
    {
      encoding: 'utf-8',
      timeout: timeoutMs
    }
  )) as PreflightWslCommandResult
  const payload = captured.readStdout(result.stdout)
  return payload === null ? result : { ...result, stdout: payload }
}
