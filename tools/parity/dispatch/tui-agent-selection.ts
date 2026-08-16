// TS dispatch for the tui-agent-selection parity module. The shared TS impl was
// DELETED (`src/shared/tui-agent-selection.ts` keeps only the catalog data —
// TUI_AGENT_AUTO_PICK_ORDER and DEFAULT_DISABLED_TUI_AGENTS) and every surface
// now reaches `orca_agents::tui_agent_selection` through
// `src/shared/tui-agent-selection-resolution.ts` on the orca-dispatch seam.
//
// Like the wsl-paths adapter, this drives the SHIM rather than the wasm oracle,
// so the harness keeps a real TS-vs-Rust differential instead of degenerating to
// wasm-vs-binary: config/vitest.parity.config.ts installs no setup file, so the
// seam is unbound here and the shim answers from its `parity` fallback — which
// is the deleted body, and the code the renderer runs before wasm init.

import {
  collapseDefaultTuiAgentToBuiltin,
  filterEnabledTuiAgents,
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents,
  pickTuiAgent
} from '../../../src/shared/tui-agent-selection-resolution'
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
      const { agent, disabled } = input as {
        agent: TuiAgent
        disabled?: unknown[] | null
      }
      return isTuiAgentEnabled(agent, disabled)
    }
    case 'filterEnabledTuiAgents': {
      const { agents, disabled } = input as {
        agents: TuiAgent[]
        disabled?: unknown[] | null
      }
      return filterEnabledTuiAgents(agents, disabled)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
