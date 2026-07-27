// TUI agent-startup plan TYPES + non-cutover re-exports.
//
// The plan BUILDERS (buildAgentStartupPlan / buildAgentResumeStartupPlan /
// buildAgentDraftLaunchPlan) were cut over to the Rust orca-agents core: the
// main process drives them via napi (`src/main/rust-tui-agent-startup.ts`) and
// the renderer via the orca-git wasm (`@/lib/git-wasm/tui-agent-startup`), both
// over the single `tuiAgentStartupOp` JSON boundary. This module keeps only the
// shared result types and re-exports the still-TS shell/detection helpers.
//
// Upstream v1.4.150 threaded `ompResumeFilePath` through
// buildAgentResumeStartupPlan -> getAgentResumeArgv (omp cold-resumes by
// transcript path, falling back to the session id). Ported to the Rust core it
// cut over to: get_agent_resume_argv has the "omp" arm and
// AgentResumeStartupPlanArgs.omp_resume_file_path carries the locator (kept
// separate from pi's transcript path — pi *requires* it, omp only *overrides*
// the id with it). Both wrappers already forward the field over the JSON
// boundary, so the napi and wasm builds must be rebuilt to pick the arm up.
import { isShellProcess } from './agent-detection'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { TuiAgent } from './types'
import type { SessionOptionValue } from './native-chat-session-options'

export type AgentStartupPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
  launchConfig: SleepingAgentLaunchConfig
  launchToken?: string
  draftPrompt?: string | null
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
  /** Values actually emitted into this launch command, kept as base model ids
   * so the native-chat surface can render only launch-backed state. */
  sessionOptions?: Record<string, SessionOptionValue>
}

export type AgentDraftLaunchPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  launchConfig: SleepingAgentLaunchConfig
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
  sessionOptions?: Record<string, SessionOptionValue>
}

export { isShellProcess }
export {
  buildShellCommandFromArgv,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  resolveStartupShell
} from './tui-agent-startup-shell'
export type { AgentCliArgsPlan, AgentStartupShell } from './tui-agent-startup-shell'
