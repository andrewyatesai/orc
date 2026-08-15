import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { createRuntimeAgentBackgroundTerminal } from '@/lib/runtime-agent-background-create'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { isWslUncPath } from '../../../shared/wsl-unc-paths'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'

export type SpawnAgentBackgroundProviderArgs = {
  runtimeTarget: RuntimeClientTarget
  agent: TuiAgent
  worktreeId: string
  worktreePath: string
  reservedTabId: string
  leafId: string
  startupPlan: AgentStartupPlan
  paneEnv: Record<string, string>
  launchToken: string
  trimmedPrompt: string
  hasPrompt: boolean
  isFollowupPath: boolean
  sshConnectionId: string | null
  launchSource: LaunchSource | undefined
  title: string | undefined
}

export type SpawnedAgentBackgroundProvider = {
  ptyId: string
  runtimeTerminalHandle: string | null
  launchConfig: AgentStartupPlan['launchConfig'] | undefined
}

/** Creates the background terminal on the worktree's owner host: runtime environment or local/SSH PTY. */
export async function spawnAgentBackgroundProvider(
  args: SpawnAgentBackgroundProviderArgs
): Promise<SpawnedAgentBackgroundProvider> {
  const {
    runtimeTarget,
    agent,
    worktreeId,
    worktreePath,
    reservedTabId,
    leafId,
    startupPlan,
    paneEnv,
    launchToken,
    trimmedPrompt,
    hasPrompt,
    isFollowupPath,
    sshConnectionId,
    launchSource,
    title
  } = args
  if (runtimeTarget.kind === 'environment') {
    // Why: runtime environments execute on the server; using local pty.spawn
    // would silently run automation on the client for a remote workspace.
    const created = await createRuntimeAgentBackgroundTerminal({
      environmentId: runtimeTarget.environmentId,
      worktreeId,
      tabId: reservedTabId,
      leafId,
      agent,
      ...(hasPrompt && !isFollowupPath ? { prompt: trimmedPrompt } : {}),
      ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
      legacy: {
        command: startupPlan.launchCommand,
        env: paneEnv,
        ...(startupPlan.startupCommandDelivery
          ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
          : {}),
        launchConfig: startupPlan.launchConfig,
        launchToken,
        ...(title ? { title } : {})
      }
    })
    const runtimeTerminalHandle = created.terminal.handle
    return {
      ptyId: toRemoteRuntimePtyId(runtimeTerminalHandle, runtimeTarget.environmentId),
      runtimeTerminalHandle,
      launchConfig: undefined
    }
  }
  const result = await window.api.pty.spawn({
    cols: 120,
    rows: 40,
    cwd: worktreePath,
    command: startupPlan.launchCommand,
    ...(!sshConnectionId && isWslUncPath(worktreePath) ? { shellOverride: 'wsl.exe' } : {}),
    ...(!startupPlan.startupCommandDelivery
      ? {}
      : { startupCommandDelivery: startupPlan.startupCommandDelivery }),
    env: paneEnv,
    launchConfig: startupPlan.launchConfig,
    launchToken,
    launchAgent: agent,
    connectionId: sshConnectionId,
    worktreeId,
    tabId: reservedTabId,
    leafId,
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: launchSource ?? 'unknown',
      request_kind: 'new'
    }
  })
  return { ptyId: result.id, runtimeTerminalHandle: null, launchConfig: result.launchConfig }
}
