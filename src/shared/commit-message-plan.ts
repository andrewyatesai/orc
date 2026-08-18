// The commit-message spawn planner (planCommitMessageGeneration, planAgentBinary)
// moved to the Rust orca-agents core: the main process drives it via napi
// (src/main/text-generation/rust-commit-message-plan.ts), the renderer's dry-run
// preview via the orca-git wasm (src/renderer/src/lib/git-wasm/commit-message-plan.ts),
// and the SSH provider ships a resolved plan to the relay to execute. This shared
// module keeps only the types those boundaries reference.
import type { TuiAgent } from './types'
import type { CommandTemplateBackslash } from './commit-message-prompt'

export type CommitMessagePlanInput = {
  agentId: TuiAgent | 'custom'
  /** How to read `\` in the command override / args / custom command. Defaults
   *  to POSIX escaping; pass `'literal'` only when the command is known to run on
   *  native Windows, where `\` is the path separator (#11375). Rides in the JSON
   *  the Rust planner (napi/wasm) reads. */
  backslash?: CommandTemplateBackslash
  model: string
  thinkingLevel?: string
  customAgentCommand?: string
  agentCommandOverride?: string
  agentArgs?: string
}

export type CommitMessagePlan = {
  binary: string
  args: string[]
  /** Non-null when the prompt should be piped via stdin. */
  stdinPayload: string | null
  /** Human-readable label used in error prefixes (e.g. "Claude failed: ..."). */
  label: string
}

export type CommitMessagePlanResult =
  | { ok: true; plan: CommitMessagePlan }
  | { ok: false; error: string }

export type PlanAgentBinaryResult =
  | { ok: true; binary: string; prefixArgs: string[] }
  | { ok: false; error: string }
