import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'

/** Plan inputs shared by every launch route; only the prompt fields differ. */
export type AgentLaunchPlanBase = Omit<
  Parameters<typeof buildAgentStartupPlan>[0],
  'prompt' | 'allowEmptyPromptLaunch'
>

export type AgentLaunchPromptRouting = {
  startupPlan: AgentStartupPlan | null
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
}

/**
 * Route the initial prompt to the launch path that can carry it: folded into
 * the launch command, launched as an editable draft, or pasted into the TUI
 * after it is ready.
 */
export function resolveAgentLaunchPromptRouting({
  startupPlanBase,
  trimmedPrompt,
  hasPrompt,
  personalizedPrompt,
  isFollowupPath,
  promptDelivery
}: {
  startupPlanBase: AgentLaunchPlanBase
  trimmedPrompt: string
  hasPrompt: boolean
  personalizedPrompt: string
  isFollowupPath: boolean
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
}): AgentLaunchPromptRouting {
  // argv/flag agents fold the prompt into the launch command; followup/generated launches deliver it via post-launch paste.
  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  let submitPastedPrompt = false

  if (hasPrompt && promptDelivery === 'submit-after-ready') {
    // Why: multi-line generated prompts are too large for a shell argv, so launch clean then paste+submit in the TUI.
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = personalizedPrompt
    submitPastedPrompt = true
  } else if (hasPrompt && promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      ...startupPlanBase,
      draft: trimmedPrompt
    })
    if (draftLaunchPlan) {
      startupPlan = {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.sessionOptions
          ? { sessionOptions: draftLaunchPlan.sessionOptions }
          : {}),
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      }
    } else {
      startupPlan = buildAgentStartupPlan({
        ...startupPlanBase,
        prompt: '',
        allowEmptyPromptLaunch: true
      })
      pasteDraftAfterLaunch = personalizedPrompt
    }
  } else if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = personalizedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      ...startupPlanBase,
      prompt: hasPrompt ? trimmedPrompt : '',
      allowEmptyPromptLaunch: !hasPrompt
    })
  }

  return { startupPlan, pasteDraftAfterLaunch, submitPastedPrompt }
}
