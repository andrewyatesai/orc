// Synthetic agent title decisions, resolved by `orca_core::synthetic_agent_title`
// over the shared dispatch seam. The twin (`src/shared/synthetic-agent-title.ts`)
// keeps the profile TYPE and the `SYNTHETIC_AGENT_TITLE_PROFILES` table as data:
// `agent-title-owner.ts` and `agent-row-conversation-name.ts` iterate the table
// directly, and agent-title-owner scans it IN ORDER for the first working-label
// match, so the table's order is load-bearing and stays in TS.
//
// On the seam rather than a surface binding because the callers span three trees
// and no single binding reaches them all: main (`src/main/index.ts`, napi), the
// renderer (`lib/agent-status-terminal-title.ts`,
// `terminal-pane/codex-auto-approval-notification-suppression.ts`, wasm) and
// `src/shared` itself (`agent-title-owner.ts`, `foreground-wrapper-agent.ts`,
// which also run under the SSH relay).
//
// PRE-READY CONTRACT — `parity`, and it is mandatory rather than tidy, because
// these answers are WRITTEN BACK and a wrong one sticks:
//  * `src/main/index.ts:1436` gates `driveSyntheticTitleFromHook` on
//    `shouldDriveSyntheticAgentTitleFromHook`, which then emits the profile's
//    labels into the PTY as an OSC 0 sequence (`\x1b]0;<label>\x07`). A pre-ready
//    `false` is a whole session with no synthetic titles — the renderer's title
//    tracker never gets the idle/permission frames native OSC misses — and a
//    pre-ready `true` for OpenCode overwrites the semantic session title it owns.
//  * `agent-title-owner.normalizeCompatibleAgentStatusEntryForOwner` rewrites
//    `AgentStatusEntry.terminalTitle` in mirrored remote status entries.
// No sentinel is available either: `shouldDrive…` is a total predicate with no
// spare state, and the profile's `permissionLabel` is EQUALITY-COMPARED against a
// live title at codex-auto-approval-notification-suppression.ts:68, where an
// `undefined` would silently read as "not that title".
//
// So the fallback recomputes the deleted twin's bodies over the kept table and is
// the ready answer for EVERY input. Measured, not assumed: 476 probes of the
// SHIPPED wasm (28 agent types × 8 states × 3 functions, including unknown and
// custom agent names, '', case variants, astral chars) against the deleted TS
// bodies agree everywhere except the one class below.
//
// THE ONE DISAGREEMENT, and why the fallback follows the core. `AgentType` is
// `string & {}` — custom agents exist — so `agentType` is an arbitrary wire
// string, and the twin's `TABLE[agentType]` also found INHERITED members:
// 'toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty',
// 'isPrototypeOf', 'propertyIsEnumerable' and 'toLocaleString' each returned an
// `Object.prototype` value as if it were a profile, so `shouldDrive…` answered
// true and main wrote `\x1b]0;⠋ undefined\x07` into the user's terminal. The core
// answers null/false; `localProfile` below matches it with an own-key lookup so
// pre-ready equals ready, and `synthetic-agent-title-resolution.test.ts` pins
// both halves.
import type { AgentStatusState, AgentType } from './agent-status-types'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  SYNTHETIC_AGENT_TITLE_PROFILES,
  type SyntheticAgentTitleProfile
} from './synthetic-agent-title'

const SYNTHETIC_AGENT_TITLE = 'synthetic-agent-title'

/** The twin's lookup minus its inherited-key hole — own keys only, as the core scans. */
function localProfile(agentType: AgentType | null | undefined): SyntheticAgentTitleProfile | null {
  if (!agentType || !Object.hasOwn(SYNTHETIC_AGENT_TITLE_PROFILES, agentType)) {
    return null
  }
  return SYNTHETIC_AGENT_TITLE_PROFILES[agentType] ?? null
}

function localTerminalTitle(
  agentType: AgentType | null | undefined,
  state: AgentStatusState
): string | null {
  const profile = localProfile(agentType)
  if (!profile || profile.synthesizeTerminalTitle === false || state === 'working') {
    return null
  }
  return state === 'blocked' || state === 'waiting' ? profile.permissionLabel : profile.idleLabel
}

function localShouldDrive(
  agentType: AgentType | null | undefined,
  state: AgentStatusState
): boolean {
  const profile = localProfile(agentType)
  if (!profile || profile.synthesizeTerminalTitle === false) {
    return false
  }
  return state !== 'working' || profile.synthesizeWorkingTitle !== false
}

/** `null` = the seam is unbound or the payload cannot cross, so answer locally.
 *  A real "no profile"/"no title" is also null and the local body answers those
 *  identically, so the two never need telling apart. */
function dispatchTitle(fn: string, input: unknown, root: string): unknown {
  try {
    return tryOrcaDispatch(SYNTHETIC_AGENT_TITLE, fn, input, { root })
  } catch (error) {
    // Why the catch: an agent name and a state both arrive off the wire (hook
    // payload JSON, relay status mirror), so one can carry a lone UTF-16
    // surrogate — or `state` can be absent where the type says it is required —
    // and the codec refuses to encode either. The twin answered those without
    // crossing, so the local body does too. A DispatchCoreError still propagates.
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** The synthetic title profile for an agent type, or null when it has none. */
export function getSyntheticAgentTitleProfile(
  agentType: AgentType | null | undefined
): SyntheticAgentTitleProfile | null {
  const answer = dispatchTitle('getSyntheticAgentTitleProfile', agentType ?? null, 'agentType')
  return answer === null ? localProfile(agentType) : (answer as SyntheticAgentTitleProfile)
}

/** The terminal-state title to synthesize, or null when the agent owns its own
 *  titles (OpenCode) or is still working. */
export function getSyntheticAgentTerminalTitle(
  agentType: AgentType | null | undefined,
  state: AgentStatusState
): string | null {
  const answer = dispatchTitle(
    'getSyntheticAgentTerminalTitle',
    { agentType: agentType ?? null, state },
    'agentTitle'
  )
  return answer === null ? localTerminalTitle(agentType, state) : (answer as string)
}

/** Whether a hook status update may drive this agent's terminal title. */
export function shouldDriveSyntheticAgentTitleFromHook(
  agentType: AgentType | null | undefined,
  state: AgentStatusState
): boolean {
  const answer = dispatchTitle(
    'shouldDriveSyntheticAgentTitleFromHook',
    { agentType: agentType ?? null, state },
    'agentTitle'
  )
  return answer === null ? localShouldDrive(agentType, state) : (answer as boolean)
}
