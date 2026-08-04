import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

// Agent safety is two independent axes: confinement (what the agent CAN do, OS-enforced)
// and approvals (whether it asks first). The presets are named points in that grid:
//   yolo   = unconfined + never asks   (the agent's bypass flag)
//   safe   = confined   + never asks   (OS sandbox on, prompts off — same speed as yolo)
//   manual = unconfined + agent's own prompts (empty args)
export type AgentPermissionMode = 'yolo' | 'safe' | 'manual' | 'mixed'

export const YOLO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--dangerously-skip-permissions',
  'claude-agent-teams': '--dangerously-skip-permissions',
  openclaude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
  antigravity: '--dangerously-skip-permissions',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  kiro: '--trust-all-tools',
  crush: '--yolo',
  autohand: '--unrestricted',
  cline: '--auto-approve true',
  'command-code': '--yolo',
  continue: '--allow "*"',
  cursor: '--yolo',
  kimi: '--yolo',
  'mistral-vibe': '--agent auto-approve',
  'qwen-code': '--approval-mode yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  copilot: '--yolo',
  grok: '--permission-mode bypassPermissions',
  devin: '--permission-mode bypass',
  ante: '--yolo',
  trae: '--yolo'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

// Confined + silent, expressible as launch args alone. Only agents whose confinement is
// OS-ENFORCED (not a model prompt) belong here, verified against the real CLI:
//  - codex: Seatbelt on macOS; workspace-write denies network by default; approvals off
//    is a separate axis (--ask-for-approval never).
//  - gemini: --sandbox (Seatbelt on macOS, container on Linux — errors out if unavailable);
//    --approval-mode yolo only auto-approves INSIDE the sandbox.
// Absence here is a statement: the agent has no args-expressible OS confinement (claude's
// sandbox lives in settings JSON, not flags; aider/copilot/opencode have none at all).
export const SAFE_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  codex: '--sandbox workspace-write --ask-for-approval never',
  gemini: '--sandbox --approval-mode yolo'
}

// Why: gemini's getSandboxCommand reads GEMINI_SANDBOX BEFORE the --sandbox flag value and
// lets it win, so a user shell exporting GEMINI_SANDBOX=false would silently defeat the
// flag. Injecting 'true' out-prioritizes the shell env, and gemini fails CLOSED on it
// (FatalSandboxError when no sandbox backend exists) rather than running unconfined.
export const SAFE_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  gemini: { GEMINI_SANDBOX: 'true' }
}

/** True when `safe` mode can actually confine this agent; callers that run unattended
 *  (child modes, fleet workers) should refuse to launch agents where this is false. */
export function agentSupportsConfinedLaunch(agent: TuiAgent): boolean {
  return agent in SAFE_TUI_AGENT_ARGS
}

/** Settings-file values are hand-editable; anything unrecognized reads as "no preset stored". */
export function normalizeAgentPermissionPreset(
  value: unknown
): Exclude<AgentPermissionMode, 'mixed'> | undefined {
  return value === 'yolo' || value === 'safe' || value === 'manual' ? value : undefined
}

/** The args string a preset writes for one agent — what "Reset" should restore under that
 *  preset. Under 'safe' this is the sandbox string (or '' when unconfinable), so a reset
 *  can never quietly reinstall the bypass flag on a safe profile. */
export function getPresetAgentArgs(
  agent: TuiAgent,
  preset: Exclude<AgentPermissionMode, 'mixed'>
): string {
  if (preset === 'yolo') {
    return YOLO_TUI_AGENT_ARGS[agent] ?? ''
  }
  if (preset === 'safe') {
    return SAFE_TUI_AGENT_ARGS[agent] ?? ''
  }
  return ''
}

/** The env a preset writes for one agent — the env-side twin of getPresetAgentArgs. */
export function getPresetAgentEnv(
  agent: TuiAgent,
  preset: Exclude<AgentPermissionMode, 'mixed'>
): Record<string, string> {
  if (preset === 'yolo') {
    return { ...YOLO_TUI_AGENT_ENV[agent] }
  }
  if (preset === 'safe') {
    return { ...SAFE_TUI_AGENT_ENV[agent] }
  }
  return {}
}

/**
 * Fill entries MISSING from a stored profile with the stored preset's values.
 *
 * Why: applyAgentPermissionMode writes entries for the agents that exist at the moment the
 * user clicks the preset. An agent added to the catalog in a later release has no entry, so
 * launch-arg resolution would fall through to the built-in default — which is yolo — under a
 * profile whose stored preset says safe or manual. Run at settings load so catalog growth
 * inherits the user's chosen preset instead of silently escalating. Existing entries
 * (including explicit '') are never touched.
 */
export function reconcileAgentProfileWithPreset(
  preset: Exclude<AgentPermissionMode, 'mixed'>,
  agentDefaultArgs: Partial<Record<TuiAgent, string>>,
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
): {
  agentDefaultArgs: Partial<Record<TuiAgent, string>>
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
} {
  const nextArgs = { ...agentDefaultArgs }
  const nextEnv = { ...agentDefaultEnv }
  for (const agent of PERMISSION_AGENT_IDS) {
    if (!Object.hasOwn(nextArgs, agent)) {
      nextArgs[agent] = getPresetAgentArgs(agent, preset)
    }
    if (!Object.hasOwn(nextEnv, agent)) {
      nextEnv[agent] = getPresetAgentEnv(agent, preset)
    }
  }
  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}

const PERMISSION_AGENT_IDS = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent =>
    agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV || agent in SAFE_TUI_AGENT_ENV
)

function normalizeArgs(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function sameEnv(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) {
    return false
  }
  return leftEntries.every(([name, value]) => right?.[name] === value)
}

function resolveAgentPermissionMode(
  args: string,
  yoloArgs: string,
  safeArgs: string | undefined
): AgentPermissionMode {
  if (!args) {
    return 'manual'
  }
  if (args === yoloArgs) {
    return 'yolo'
  }
  return safeArgs !== undefined && args === safeArgs ? 'safe' : 'mixed'
}

function resolveAgentEnvPermissionMode(
  env: Record<string, string> | null | undefined,
  yoloEnv: Record<string, string> | undefined
): AgentPermissionMode {
  if (sameEnv(env, {})) {
    return 'manual'
  }
  return sameEnv(env, yoloEnv) ? 'yolo' : 'mixed'
}

// For agents whose env only matters under safe (gemini): {} matches yolo AND manual, so it
// carries no signal — null tells the caller to skip it rather than poison the combine.
function resolveSafeOnlyEnvMode(
  env: Record<string, string> | null | undefined,
  safeEnv: Record<string, string> | undefined
): AgentPermissionMode | null {
  if (sameEnv(env, {})) {
    return null
  }
  return sameEnv(env, safeEnv) ? 'safe' : 'mixed'
}

function combinePermissionModes(modes: AgentPermissionMode[]): AgentPermissionMode {
  // Why manual doesn't conflict with safe: agents without an OS sandbox hold '' (manual)
  // under a safe profile by design, so safe+manual is the expected safe-profile shape.
  // Yolo conflicts with everything else — one unconfined silent agent breaks the profile.
  const seen = new Set(modes)
  if (seen.has('mixed') || (seen.has('yolo') && (seen.has('manual') || seen.has('safe')))) {
    return 'mixed'
  }
  if (seen.has('yolo')) {
    return 'yolo'
  }
  if (seen.has('safe')) {
    return 'safe'
  }
  return 'manual'
}

export function resolveTuiAgentPermissionMode(args: {
  agent: TuiAgent
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []
  if (args.agent in YOLO_TUI_AGENT_ARGS) {
    modes.push(
      resolveAgentPermissionMode(
        normalizeArgs(args.agentArgs),
        YOLO_TUI_AGENT_ARGS[args.agent] ?? '',
        SAFE_TUI_AGENT_ARGS[args.agent]
      )
    )
  }
  if (args.agent in YOLO_TUI_AGENT_ENV) {
    modes.push(resolveAgentEnvPermissionMode(args.agentEnv, YOLO_TUI_AGENT_ENV[args.agent]))
  } else if (args.agent in SAFE_TUI_AGENT_ENV) {
    const envMode = resolveSafeOnlyEnvMode(args.agentEnv, SAFE_TUI_AGENT_ENV[args.agent])
    if (envMode !== null) {
      modes.push(envMode)
    }
  }

  return combinePermissionModes(modes)
}

export function resolveAgentPermissionModeSummary(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []

  for (const agent of PERMISSION_AGENT_IDS) {
    modes.push(
      resolveTuiAgentPermissionMode({
        agent,
        agentArgs: args.agentDefaultArgs?.[agent],
        agentEnv: args.agentDefaultEnv?.[agent]
      })
    )
  }

  return combinePermissionModes(modes)
}

export function applyAgentPermissionMode(args: {
  mode: Exclude<AgentPermissionMode, 'mixed'>
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): {
  agentDefaultArgs: Partial<Record<TuiAgent, string>>
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
} {
  const nextArgs = { ...args.agentDefaultArgs }
  const nextEnv = { ...args.agentDefaultEnv }

  for (const agent of PERMISSION_AGENT_IDS) {
    if (agent in YOLO_TUI_AGENT_ARGS) {
      const yoloArgs = YOLO_TUI_AGENT_ARGS[agent] ?? ''
      const safeArgs = SAFE_TUI_AGENT_ARGS[agent]
      const currentArgs = normalizeArgs(nextArgs[agent])
      // Why: only rewrite args we recognize as a preset — a user's custom string never gets clobbered.
      const isPresetArgs = !currentArgs || currentArgs === yoloArgs || currentArgs === safeArgs
      if (isPresetArgs) {
        // Why safe falls back to '': an agent with no OS confinement runs manual (its own
        // prompts) rather than silently unconfined — prompts block, bypass destroys.
        nextArgs[agent] =
          args.mode === 'yolo' ? yoloArgs : args.mode === 'safe' ? (safeArgs ?? '') : ''
      }
    }

    const yoloEnv = agent in YOLO_TUI_AGENT_ENV ? YOLO_TUI_AGENT_ENV[agent] : undefined
    const safeEnv = SAFE_TUI_AGENT_ENV[agent]
    if (yoloEnv !== undefined || safeEnv !== undefined) {
      const currentEnv = nextEnv[agent]
      const isPresetEnv =
        sameEnv(currentEnv, {}) ||
        (yoloEnv !== undefined && sameEnv(currentEnv, yoloEnv)) ||
        (safeEnv !== undefined && sameEnv(currentEnv, safeEnv))
      if (isPresetEnv) {
        nextEnv[agent] =
          args.mode === 'yolo' ? { ...yoloEnv } : args.mode === 'safe' ? { ...safeEnv } : {}
      }
    }
  }

  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}
