// Main-process TUI agent-startup plan builders, driven by the Rust orca-agents
// core via napi (the shared TS bodies were deleted). The main runtime builds the
// startup, draft and resume plans (resume became host-owned with the
// agent-session host-authority routes); all go through the single
// `tuiAgentStartupOp` boundary. The napi binding is synchronous and always
// present (the daemon fails fast without the addon).
import { requireRustGitBinding } from './daemon/rust-git-addon'
import type { AgentDraftLaunchPlan, AgentStartupPlan } from '../shared/tui-agent-startup'
import type { AgentStartupShell } from '../shared/tui-agent-startup-shell'
import type { SessionOptionValue } from '../shared/native-chat-session-options'
import { spliceSessionOptionsIntoPlan } from '../shared/tui-agent-session-option-splice'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent
} from '../shared/agent-session-resume'
import type { TuiAgent } from '../shared/types'

function op<T>(fn: string, input: unknown): T | null {
  return JSON.parse(
    requireRustGitBinding().tuiAgentStartupOp(fn, JSON.stringify(input))
  ) as T | null
}

export function buildAgentStartupPlan(args: {
  agent: TuiAgent
  prompt: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  allowEmptyPromptLaunch?: boolean
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  sessionOptions?: Record<string, SessionOptionValue>
  isRemote?: boolean
}): AgentStartupPlan | null {
  const plan = op<AgentStartupPlan>('buildAgentStartupPlan', args)
  // Layer the native-chat session-option flags (upstream #9085) over the Rust
  // plan; a no-catalog agent or absent options is an identity pass.
  return plan ? spliceSessionOptionsIntoPlan(plan, args) : plan
}

export function buildAgentResumeStartupPlan(args: {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  agentCommand?: string | null
  /** OMP's exact transcript-file locator; the Rust arm falls back to the
   * session id when it is absent or blank. */
  ompResumeFilePath?: string | null
  /** Accepted for call-site parity; resume restores the provider session's own
   * state, so picker flags are never replayed (matches upstream). */
  sessionOptions?: Record<string, SessionOptionValue>
  isRemote?: boolean
}): AgentStartupPlan | null {
  return op<AgentStartupPlan>('buildAgentResumeStartupPlan', args)
}

export function buildAgentDraftLaunchPlan(args: {
  agent: TuiAgent
  draft: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  sessionOptions?: Record<string, SessionOptionValue>
  isRemote?: boolean
}): AgentDraftLaunchPlan | null {
  const plan = op<AgentDraftLaunchPlan>('buildAgentDraftLaunchPlan', args)
  return plan ? spliceSessionOptionsIntoPlan(plan, args) : plan
}
