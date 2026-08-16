// TS dispatch for the agent-status-types parity module: maps the shared vector
// function names to the real `src/shared/agent-status-types.ts` exports so the
// harness compares the live TS reference against the Rust port.

import {
  agentSubagentsEqual,
  hasUnsettledOrUnknownDispatch,
  isFreshNonDoneAgentStatus,
  normalizeAgentStatusPayload,
  parseAgentStatusPayload,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext,
  type AgentSubagentSnapshot
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
