// Agent <-> telemetry-kind mapping, driven by the Rust `orca_core::agent_kind`
// core via the orca-git wasm module (the shared TS maps were deleted). Pre-ready
// (wasm still booting) `tuiAgentToAgentKind` degrades to the `other` catch-all —
// the same value an out-of-union agent already yields — so telemetry still emits
// a valid closed enum; `agentKindToTuiAgent` degrades to null, which every
// caller already treats as "no concrete agent" (`?? undefined`).
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { AgentKind } from '../../../../shared/telemetry-events'
import type { TuiAgent } from '../../../../shared/types'

// Why 'omit': an absent `kind` key IS the Rust None that maps to "no concrete
// agent" — see agentKindToTuiAgent below.
function op(fn: string, input: unknown): unknown {
  if (!isGitWasmReady()) {
    return null
  }
  return dispatchToWasmCore('agent-kind', fn, input, { undefinedProperties: 'omit' })
}

export function tuiAgentToAgentKind(agent: TuiAgent): AgentKind {
  const r = op('tuiAgentToAgentKind', { agent }) as AgentKind | null
  return r ?? 'other'
}

export function agentKindToTuiAgent(kind: AgentKind | null | undefined): TuiAgent | null {
  // Missing/undefined `kind` stringifies to `{}` (Rust reads it as None) — the
  // same null the "no concrete agent" mapping returns.
  const r = op('agentKindToTuiAgent', { kind }) as TuiAgent | null
  return r ?? null
}
