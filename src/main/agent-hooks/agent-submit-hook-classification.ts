/**
 * Which agent-hook arrivals are submit evidence, and at what strength.
 *
 * §5.2a's measured table is deliberately *not* restated here. It lives in
 * `runtime/agent-submit-evidence.ts` keyed by launch profile (`TuiAgent`), while hooks arrive
 * keyed by hook source (`AgentHookSource`), and the two identities are not interchangeable —
 * an `openclaude` pane posts its hooks as source `claude`. Keeping a second copy in hook-source
 * space is exactly how the two drifted apart over `mimo-code` and `command-code`, so this module
 * maps between the spaces and owns only what the shared table cannot know: which normalized
 * event names each CLI actually emits at submit time.
 *
 * Pure module: no Electron, no I/O.
 */
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type { AgentType } from '../../shared/agent-status-types'
import {
  agentSubmitCertification,
  type AgentSubmitCertification
} from '../runtime/agent-submit-evidence'

/** `certified`: §5.2a's table certifies this signal as proof a turn was submitted.
 *  `observed`: a turn boundary that is not proof — evidence for `unknown`, never for `yes`. */
export type SubmitEvidenceTier = 'certified' | 'observed'

type SubmitHookEvents = {
  /** Normalized names of this CLI's submit-time events. Whether they certify is the shared
   *  table's call, never this list's. */
  submits?: readonly string[]
  /** A submit event that carried no prompt text drops to `observed` even for a certified CLI. */
  requiresExplicitPrompt?: boolean
}

/** Keyed by hook source because every normalizer stamps `agentType` with its own source name.
 *  A source with no submit event reaches `observed` through the generic explicit-prompt rule
 *  below, which is exactly as far as the evidence goes. */
const SUBMIT_HOOK_EVENTS: Record<AgentHookSource, SubmitHookEvents> = {
  claude: { submits: ['user_prompt_submit'], requiresExplicitPrompt: true },
  codex: { submits: ['user_prompt_submit'], requiresExplicitPrompt: true },
  cursor: { submits: ['before_submit_prompt'] },
  droid: { submits: ['user_prompt_submit'] },
  grok: { submits: ['user_prompt_submit'] },
  // No submit event at all — the per-turn key is the turn boundary for this family.
  opencode: {},
  'mimo-code': {},
  'command-code': {},
  // Prompt-less turn starts. Submit-shaped, and the shared table certifies none of them.
  gemini: { submits: ['before_agent'] },
  hermes: { submits: ['pre_llm_call'] },
  pi: { submits: ['before_agent_start'] },
  omp: { submits: ['before_agent_start'] },
  kimi: {},
  copilot: {},
  devin: {},
  amp: {},
  antigravity: {}
}

/** Mirrors the listener's private `normalizeHookEventName` so `userPromptSubmit`,
 *  `UserPromptSubmit` and `user_prompt_submit` collapse to one key. */
function normalizeEventName(value: string | undefined): string {
  return value === undefined
    ? ''
    : value
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase()
}

/** `AgentType` is an open string union, so an unmeasured CLI narrows to `null` and certifies
 *  nothing. The call below is also the compile-time proof that every hook source is a
 *  launchable agent — the one point where the two identity spaces are allowed to meet. */
function hookSourceOf(agentType: AgentType | undefined): AgentHookSource | null {
  return agentType !== undefined && Object.hasOwn(SUBMIT_HOOK_EVENTS, agentType)
    ? (agentType as AgentHookSource)
    : null
}

function certificationFor(agentType: AgentType | undefined): AgentSubmitCertification {
  return agentSubmitCertification(hookSourceOf(agentType))
}

/** Whether §5.2a certifies this agent's submit signal at all — the key for §6.5's allowlist. */
export function agentTypeCertifiesSubmit(agentType: AgentType | undefined): boolean {
  const certification = certificationFor(agentType)
  return certification.submitSignal === 'certified' || certification.perTurnKey !== 'none'
}

export type SubmitArrivalClassification = {
  tier: SubmitEvidenceTier
  /** This family has no submit event, so certification rests on the per-turn key being new to
   *  the *reading* window — a strength the recorder cannot judge on its own. */
  certifiesOnNewPerTurnKey: boolean
}

/** Structural input rather than the hook event itself, so the table stays independent of the
 *  observer's retained-arrival shape. Returns null for a hook that is not turn evidence. */
export function classifySubmitHookArrival(arrival: {
  agentType?: AgentType
  hookEventName?: string
  hasExplicitPrompt: boolean
  hasPerTurnKey: boolean
}): SubmitArrivalClassification | null {
  const source = hookSourceOf(arrival.agentType)
  const certification = agentSubmitCertification(source)
  if (certification.perTurnKey !== 'none' && arrival.hasPerTurnKey) {
    return { tier: 'observed', certifiesOnNewPerTurnKey: true }
  }
  const events = source === null ? undefined : SUBMIT_HOOK_EVENTS[source]
  if (events?.submits?.includes(normalizeEventName(arrival.hookEventName))) {
    const certifies =
      certification.submitSignal === 'certified' &&
      (events.requiresExplicitPrompt !== true || arrival.hasExplicitPrompt)
    return { tier: certifies ? 'certified' : 'observed', certifiesOnNewPerTurnKey: false }
  }
  // Why: explicit prompt text is main's generic new-turn signal; it says a turn started, not whose.
  return arrival.hasExplicitPrompt ? { tier: 'observed', certifiesOnNewPerTurnKey: false } : null
}
