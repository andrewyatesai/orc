// Types + the feature-tip catalog. The eligibility, ordering and id-normalization
// logic is CUT OVER to `orca_config::feature_tips`; every caller reaches it
// through `src/shared/feature-tip-selection.ts` on the orca-dispatch seam. The
// catalog stays here because it is the copy the tip dialogs render and
// `dev-education-suppression.ts` enumerates, and because the shim's pre-ready
// fallback rebuilds the deleted bodies out of it.
import type { FeatureInteractionId, FeatureInteractionState } from './feature-interactions'

export type FeatureTipId = 'voice-dictation' | 'orca-cli' | 'cmd-j-palette'

export type FeatureTipPriority = 'new' | 'unseen'

export type FeatureTipAction = 'enable-voice' | 'setup-cli' | 'learn-cmd-j-palette'

export type FeatureTip = {
  id: FeatureTipId
  priority: FeatureTipPriority
  eyebrow: string
  title: string
  description: string
  action: FeatureTipAction
  ctaLabel: string
  /** Feature interactions that mean this tip is no longer useful to show. */
  completedByFeatureInteractions?: readonly FeatureInteractionId[]
}

export type CompletedFeatureTipState = {
  cliInstalled: boolean
  voiceDictationEnabled: boolean
  featureInteractions?: FeatureInteractionState
}

export const FEATURE_TIPS = [
  {
    id: 'orca-cli',
    priority: 'new',
    eyebrow: 'Tip',
    title: 'Let agents drive Orca with the Orca CLI',
    description: 'Enable agents to coordinate child worktrees and communicate between worktrees.',
    action: 'setup-cli',
    ctaLabel: 'Install CLI & Skills',
    completedByFeatureInteractions: []
  },
  {
    id: 'cmd-j-palette',
    priority: 'new',
    eyebrow: 'Tip',
    // Why: "<shortcut>" is a placeholder token; the cmd-j dialog splits the
    // title on it and inlines the live, platform-correct keybinding as a <kbd>.
    title: 'Jump to a worktree with <shortcut>',
    description:
      'Search worktrees, switch tabs, tweak settings, or spin up a new worktree, all without leaving the keyboard.',
    action: 'learn-cmd-j-palette',
    ctaLabel: 'Got it',
    completedByFeatureInteractions: []
  },
  {
    id: 'voice-dictation',
    priority: 'unseen',
    eyebrow: 'Tip',
    title: 'Voice Dictation is here',
    description:
      'Speak into any focused pane and Orca will transcribe it. Press the dictation shortcut to start and stop.',
    action: 'enable-voice',
    ctaLabel: 'Set Up Voice',
    completedByFeatureInteractions: ['voice-dictation']
  }
] as const satisfies readonly FeatureTip[]

export const FEATURE_TIP_IDS = FEATURE_TIPS.map((tip) => tip.id)
