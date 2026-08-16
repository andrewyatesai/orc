// TS dispatch for the commit-message-agent-spec parity module: maps the shared
// vector function names to the real `src/shared/commit-message-agent-spec.ts`
// exports so the harness compares the live TS reference against the Rust port.
//
// That module was CUT OVER in place — same path, same exports, dispatch bodies —
// so this import line did not change and this adapter now drives the SHIM.
// `config/vitest.parity.config.ts` installs no setup file, so the seam is UNBOUND
// here and the shim answers from its `parity` fallback: exactly the deleted
// bodies, and exactly what a surface runs before wasm is ready. This stays a real
// TS-vs-Rust differential either way, and it is the leg that runs against the
// NATIVELY built crate — the two suites in `src/shared` bind the wasm blob.
//
// `getCommitMessageAgentSpec` has no case here and no Rust arm: its answer
// carries `buildArgs` and `modelDiscovery.parse`, which JSON cannot express.
//
// No `?? null` on the undefined-returning exports: the arm spells a miss
// `Value::Null` and `compare.ts` never equates that with TS `undefined`, so the
// corpus only carries DEFINED answers for those four. The misses are covered in
// `commit-message-agent-spec-pre-ready.test.ts` instead.

import {
  getCommitMessageAgentCapability,
  getCommitMessageModel,
  getCommitMessageModelCapability,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  listCommitMessageAgentIds,
  resolveCommitMessageAgentChoice,
  type CommitMessageAgentChoice,
  type DefaultTuiAgentPreference
} from '../../../src/shared/commit-message-agent-spec'
import type { TuiAgent } from '../../../src/shared/types'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'isCustomAgentId':
      // Single raw arg: JSON null stands in for both TS null and undefined; both yield false.
      return isCustomAgentId(input as string | null | undefined)
    case 'resolveCommitMessageAgentChoice': {
      const { configuredAgentId, defaultTuiAgent, disabledTuiAgents } = input as {
        configuredAgentId?: CommitMessageAgentChoice | null
        defaultTuiAgent?: DefaultTuiAgentPreference
        disabledTuiAgents?: unknown[] | null
      }
      return resolveCommitMessageAgentChoice(configuredAgentId, defaultTuiAgent, disabledTuiAgents)
    }
    case 'getCommitMessageModel': {
      const { agentId, modelId } = input as { agentId: TuiAgent; modelId: string }
      return getCommitMessageModel(agentId, modelId)
    }
    case 'getCommitMessageAgentCapability': {
      const { agentId } = input as { agentId: TuiAgent }
      return getCommitMessageAgentCapability(agentId)
    }
    case 'getCommitMessageModelCapability': {
      const { agentId, modelId } = input as { agentId: TuiAgent; modelId: string }
      return getCommitMessageModelCapability(agentId, modelId)
    }
    case 'listCommitMessageAgentIds':
      return listCommitMessageAgentIds()
    case 'listCommitMessageAgentCapabilities':
      return listCommitMessageAgentCapabilities()
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
