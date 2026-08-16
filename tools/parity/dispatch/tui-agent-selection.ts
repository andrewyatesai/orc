// TS dispatch for the tui-agent-selection parity module: maps the shared vector
// function names to the real `src/shared/tui-agent-selection.ts` exports so the
// harness compares the live TS reference against the Rust port.

import {
  collapseDefaultTuiAgentToBuiltin,
  filterEnabledTuiAgents,
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents,
  pickTuiAgent
} from '../../../src/shared/tui-agent-selection'
import type { CustomAgentProfile, TuiAgent } from '../../../src/shared/types'

/** `undefined` has no JSON image, and this collapse must keep it distinct from
 *  `null` (callers spread the answer into props/IPC payloads where an absent key
 *  and null differ). Both legs answer this sentinel, as `repo-icon` does for its
 *  tri-state result. */
const COLLAPSE_UNDEFINED = '__undefined__'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'collapseDefaultTuiAgentToBuiltin': {
      // An absent `pref` key is the TS `undefined` argument.
      const { pref, customAgents } = input as {
        pref?: TuiAgent | 'blank' | { kind: 'custom'; id: string } | null
        customAgents?: CustomAgentProfile[] | null
      }
      const collapsed = collapseDefaultTuiAgentToBuiltin(pref, customAgents)
      return collapsed === undefined ? COLLAPSE_UNDEFINED : collapsed
    }
    case 'pickTuiAgent': {
      const { preferred, detected, disabled } = input as {
        preferred: TuiAgent | 'blank' | null | undefined
        detected: TuiAgent[]
        disabled?: unknown[] | null
      }
      return pickTuiAgent(preferred, detected, disabled)
    }
    case 'normalizeDisabledTuiAgents':
      return normalizeDisabledTuiAgents(input)
    case 'isTuiAgentEnabled': {
      const { agent, disabled } = input as { agent: TuiAgent; disabled?: unknown[] | null }
      return isTuiAgentEnabled(agent, disabled)
    }
    case 'filterEnabledTuiAgents': {
      const { agents, disabled } = input as { agents: TuiAgent[]; disabled?: unknown[] | null }
      return filterEnabledTuiAgents(agents, disabled)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
