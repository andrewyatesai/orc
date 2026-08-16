// TS dispatch for the agent-status-types parity module. The shared TS impl was
// DELETED (`src/shared/agent-status-types.ts` keeps only the payload/entry
// shapes and the caps) — every surface now reaches
// `orca_agents::agent_status_types` through
// `src/shared/agent-status-evaluation.ts` on the orca-dispatch seam.
//
// Like the wsl-paths, worktree-id, stable-pane-id, branch-name-from-work and
// tab-title-resolution adapters, this drives the SHIM rather than the wasm
// oracle, and the harness keeps a real TS-vs-Rust differential instead of
// degenerating to wasm-vs-binary: config/vitest.parity.config.ts installs no
// setup file, so the seam is unbound here and the shim answers from its
// `parity` fallback — which is exactly the deleted body, and exactly the code
// every renderer caller runs before (or without) a wasm binding.

import {
  agentSubagentsEqual,
  hasUnsettledOrUnknownDispatch,
  isFreshNonDoneAgentStatus,
  normalizeAgentStatusPayload,
  parseAgentStatusPayload
} from '../../../src/shared/agent-status-evaluation'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentSubagentSnapshot
} from '../../../src/shared/agent-status-types'

type FreshnessInput = {
  entry?: Pick<AgentStatusEntry, 'state' | 'updatedAt'>
  now?: number
  staleAfterMs?: number
}

type SubagentsInput = { a?: AgentSubagentSnapshot[]; b?: AgentSubagentSnapshot[] }

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'parseAgentStatusPayload':
      // Single arg: the raw JSON payload string the agent sent over the hook/OSC.
      return parseAgentStatusPayload(input as string)
    case 'normalizeAgentStatusPayload':
      // Single arg: the already-deserialized payload object (the IPC path).
      return normalizeAgentStatusPayload(input)
    case 'hasUnsettledOrUnknownDispatch':
      // Single arg: the status entry; only `.orchestration` is read.
      return hasUnsettledOrUnknownDispatch(
        input as { orchestration?: AgentStatusOrchestrationContext }
      )
    case 'isFreshNonDoneAgentStatus': {
      const { entry, now, staleAfterMs } = (input ?? {}) as FreshnessInput
      // Why: the twin defaults `now` to Date.now(), so a vector that omits it
      // would compare the Rust answer against a different instant on every run.
      // A shim crossing this boundary has to stamp `now` at the TS edge too.
      if (now === undefined) {
        throw new Error('isFreshNonDoneAgentStatus vectors must pass an explicit `now`')
      }
      // Why the arity branch: `pnpm parity:twin-derived` measures the argument
      // encoding by replaying these calls, and its JSONL recorder turns a
      // trailing explicit `undefined` into `null` — which no longer matches the
      // absent vector key, so the whole function reads as UNDERIVABLE. Omitting
      // the argument is also what actually exercises the twin's default.
      return staleAfterMs === undefined
        ? isFreshNonDoneAgentStatus(entry, now)
        : isFreshNonDoneAgentStatus(entry, now, staleAfterMs)
    }
    case 'agentSubagentsEqual': {
      const { a, b } = (input ?? {}) as SubagentsInput
      return agentSubagentsEqual(a, b)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
