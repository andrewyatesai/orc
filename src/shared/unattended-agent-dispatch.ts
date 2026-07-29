import type { TuiAgent } from './types'
import {
  agentSupportsConfinedLaunch,
  normalizeAgentPermissionPreset,
  resolveTuiAgentPermissionMode
} from './tui-agent-permissions'

export type UnattendedAgentDispatchDecision = { refuse: false } | { refuse: true; reason: string }

/**
 * Fail-closed gate for driving an agent with nobody watching (fleet workers now; any
 * future unattended mode inherits it).
 *
 * Under the Safe preset the rule is strict: dispatch only to workers whose ACTUAL launch
 * verifies as confined + silent. A warning nobody reads is not a safeguard, so anything
 * unverifiable refuses with a reason that names the fix — the coordinator's run log
 * carries it. Judged against the worker's real launch config, never stored intent, so a
 * hand-launched bypass worker cannot hide behind a Safe label.
 *
 * A terminal with no identified agent is allowed: there is nothing to judge and typing a
 * prompt into a bare shell was never a safety boundary.
 */
export function decideUnattendedAgentDispatch(args: {
  preset: unknown
  agent: TuiAgent | null | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): UnattendedAgentDispatchDecision {
  if (normalizeAgentPermissionPreset(args.preset) !== 'safe') {
    return { refuse: false }
  }
  if (!args.agent) {
    return { refuse: false }
  }
  if (!agentSupportsConfinedLaunch(args.agent)) {
    return {
      refuse: true,
      reason: `agent '${args.agent}' has no OS sandbox and the Safe preset is on — use a confinable agent (codex, gemini) for unattended work`
    }
  }
  const mode = resolveTuiAgentPermissionMode({
    agent: args.agent,
    agentArgs: args.agentArgs,
    agentEnv: args.agentEnv
  })
  if (mode === 'safe') {
    return { refuse: false }
  }
  return {
    refuse: true,
    reason:
      mode === 'yolo'
        ? `agent '${args.agent}' was launched with bypass flags — relaunch it with the Safe preset before unattended dispatch`
        : `agent '${args.agent}' was launched with ${mode === 'manual' ? 'its own prompts on' : 'unverifiable custom flags'} — relaunch it with the Safe preset so unattended work stays confined and unblocked`
  }
}
