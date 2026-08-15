import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion
} from '../../../src/shared/ai-vault-resume-command'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import { isResumableTuiAgent } from '../../../src/shared/agent-session-resume'
import type { SleepingAgentLaunchConfig } from '../../../src/shared/agent-session-resume'
// Why: desktop builds this plan in Rust (napi/wasm); mobile uses the TS twin.
import { buildAgentResumeStartupPlan } from './agent-resume-startup-plan'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../src/shared/tui-agent-launch-defaults'
import { normalizeAiVaultResumeFilePath } from '../../../src/shared/ai-vault-resume-path'
import type { TuiAgent } from '../../../src/shared/types'
import { parseWslUncPath } from '../../../src/shared/wsl-unc-paths'
import { resolveWindowsShellStartupFamily } from '../../../src/shared/windows-terminal-shell'
import type { RpcClient } from '../transport/rpc-client'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted,
  type MobileReviewTerminalTab
} from './mobile-diff-review-rpc'

// Re-exported for existing callers that import the host-platform readers from here.
export {
  readMobileRuntimeHostPlatform,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform
} from './ai-vault-resume-host-platform'

export function buildMobileAiVaultResumeCommand(args: {
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'cwd' | 'codexHome'> &
    Partial<Pick<AiVaultSession, 'filePath'>>
  hostPlatform: NodeJS.Platform
  hostTerminalWindowsShell?: string | null
  commandOverride?: string | null
}): string {
  // Why: this command is typed into the freshly created host terminal, so on
  // Windows it must match the host's live shell instead of the phone platform.
  const shell =
    args.hostPlatform === 'win32'
      ? resolveWindowsShellStartupFamily(args.hostTerminalWindowsShell)
      : undefined
  const codexHome = getMobileAiVaultResumeCodexHome(args.session.codexHome, args.hostPlatform)
  // Why: pi resumes only by transcript path (#8876); without one there is no
  // valid resume target, so launch pi fresh instead of a bare-id --session
  // argument the CLI rejects.
  if (args.session.agent === 'pi' && !args.session.filePath?.trim()) {
    return buildAiVaultResumeShellCommand({
      resumeCommand: args.commandOverride?.trim() || 'pi',
      cwd: args.session.cwd,
      platform: args.hostPlatform,
      codexHome,
      shell
    })
  }
  return buildAiVaultResumeCommand({
    agent: args.session.agent,
    // Why: pi's --session locator is the transcript path (#8876); the shared
    // builder path-swaps omp only, so hand pi the path as its session id.
    sessionId:
      args.session.agent === 'pi' && args.session.filePath?.trim()
        ? args.session.filePath.trim()
        : args.session.sessionId,
    // Why: OMP resumes by absolute transcript path (custom OMP dir / WSL-store
    // sessions miss on an id lookup), so mobile forwards it like desktop does.
    resumeFilePath: normalizeAiVaultResumeFilePath(args.session.filePath, args.hostPlatform),
    cwd: args.session.cwd,
    platform: args.hostPlatform,
    commandOverride: args.commandOverride,
    codexHome,
    shell
  })
}

export type MobileAiVaultResumeSettings = {
  agentCmdOverrides?: Partial<Record<TuiAgent, string | null>>
  agentDefaultArgs?: Partial<Record<TuiAgent, string>>
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
}

export type MobileAiVaultResumeLaunch = {
  command: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
}

export function buildMobileAiVaultResumeLaunch(args: {
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'cwd' | 'codexHome'> &
    Partial<Pick<AiVaultSession, 'filePath'>>
  hostPlatform: NodeJS.Platform
  hostTerminalWindowsShell?: string | null
  settings?: MobileAiVaultResumeSettings | null
}): MobileAiVaultResumeLaunch {
  const shell =
    args.hostPlatform === 'win32'
      ? resolveWindowsShellStartupFamily(args.hostTerminalWindowsShell)
      : undefined
  const codexHome = getMobileAiVaultResumeCodexHome(args.session.codexHome, args.hostPlatform)
  const cmdOverrides = normalizeMobileAiVaultResumeCommandOverrides(
    args.settings?.agentCmdOverrides
  )
  const commandOverride = cmdOverrides[args.session.agent] ?? null
  const resumeFilePath = normalizeAiVaultResumeFilePath(args.session.filePath, args.hostPlatform)
  if (isResumableTuiAgent(args.session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: args.session.agent,
      providerSession: {
        key: 'session_id',
        id: args.session.sessionId,
        // Why: pi resumes by transcript path, never by bare session id (#8876).
        ...(args.session.agent === 'pi' && args.session.filePath
          ? { transcriptPath: args.session.filePath }
          : {})
      },
      cmdOverrides,
      platform: args.hostPlatform,
      shell,
      agentArgs: resolveTuiAgentLaunchArgs(args.session.agent, args.settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(args.session.agent, args.settings?.agentDefaultEnv),
      ...(args.session.agent === 'omp' && resumeFilePath
        ? { ompResumeFilePath: resumeFilePath }
        : {})
    })
    if (startupPlan) {
      return {
        command:
          args.session.agent === 'omp'
            ? buildMobileAiVaultResumeCommand({
                session: {
                  ...args.session,
                  ...(resumeFilePath ? { filePath: resumeFilePath } : {})
                },
                hostPlatform: args.hostPlatform,
                hostTerminalWindowsShell: args.hostTerminalWindowsShell,
                commandOverride: startupPlan.launchConfig.agentCommand
              })
            : buildAiVaultResumeShellCommand({
                resumeCommand: startupPlan.launchCommand,
                cwd: args.session.cwd,
                platform: args.hostPlatform,
                codexHome,
                shell
              }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        // Why: the resume command is typed into the created pane, so the bare
        // real-home override must strip Codex homes at pane spawn like desktop.
        ...realHomeCodexResumeEnvDeletion(args.session),
        launchConfig: startupPlan.launchConfig,
        launchAgent: startupPlan.agent
      }
    }
  }
  return {
    command: buildMobileAiVaultResumeCommand({
      session: args.session,
      hostPlatform: args.hostPlatform,
      hostTerminalWindowsShell: args.hostTerminalWindowsShell,
      commandOverride
    }),
    ...realHomeCodexResumeEnvDeletion(args.session)
  }
}

function normalizeMobileAiVaultResumeCommandOverrides(
  overrides: Partial<Record<TuiAgent, string | null>> | null | undefined
): Partial<Record<TuiAgent, string>> {
  const normalized: Partial<Record<TuiAgent, string>> = {}
  if (!overrides) {
    return normalized
  }
  for (const [agent, command] of Object.entries(overrides) as [TuiAgent, string | null][]) {
    if (typeof command === 'string' && command.trim()) {
      normalized[agent] = command
    }
  }
  return normalized
}

export async function resumeAiVaultSessionInTerminal(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  launch: MobileAiVaultResumeLaunch & { clientMutationId?: string }
): Promise<MobileReviewTerminalTab> {
  const created = await client.sendRequest(
    'session.tabs.createTerminal',
    {
      worktree: `id:${worktreeId}`,
      ...(launch.env ? { env: launch.env } : {}),
      ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
      ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
      ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
      ...(launch.clientMutationId ? { clientMutationId: launch.clientMutationId } : {}),
      activate: false,
      select: true,
      navigation: 'caller'
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!created.ok) {
    throw new Error(created.error?.message || 'Failed to create terminal')
  }
  const terminalTab = readMobileReviewCreatedTerminal(created.result)
  if (!terminalTab) {
    throw new Error('Created terminal response was invalid')
  }
  const sent = await client.sendRequest(
    'terminal.send',
    {
      terminal: terminalTab.terminal,
      text: launch.command,
      enter: true
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!sent.ok) {
    throw new Error(sent.error?.message || 'Failed to send resume command')
  }
  if (!readMobileReviewTerminalSendAccepted(sent.result)) {
    throw new Error('Terminal input is locked')
  }
  return terminalTab
}

export type MobileAiVaultResumeMutationRegistry = {
  claim(sessionId: string): string
  releaseOnSuccess(sessionId: string): void
}

// Why: a retry after a failed/interrupted resume must reuse the same
// idempotency key so the host dedups the create, while a resume after success
// mints a fresh key so the user can intentionally fork the session.
export function createMobileAiVaultResumeMutationRegistry(
  mintId: (sessionId: string) => string
): MobileAiVaultResumeMutationRegistry {
  const bySessionId = new Map<string, string>()
  return {
    claim(sessionId: string): string {
      const existing = bySessionId.get(sessionId)
      if (existing) {
        return existing
      }
      const minted = mintId(sessionId)
      bySessionId.set(sessionId, minted)
      return minted
    },
    releaseOnSuccess(sessionId: string): void {
      bySessionId.delete(sessionId)
    }
  }
}

function getMobileAiVaultResumeCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}
