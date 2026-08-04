import { resolveDefaultTuiAgentPreference } from '@/lib/custom-agent-resolve'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import type { CustomAgentProfile, GlobalSettings, TuiAgent } from '../../../shared/types'

/** The slice of app state agent detection needs, narrowed so selection doesn't
 *  depend on the whole store. */
type DetectedAgentsStore = {
  settings: GlobalSettings | null
  ensureDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  ensureRemoteDetectedAgents: (
    connectionId: string,
    options?: { force?: boolean }
  ) => Promise<TuiAgent[]>
}

export type DirectWorkItemAgentSelection =
  /** The caller's explicit `agentOverride` is missing from PATH or disabled. */
  | { kind: 'unavailable' }
  | { kind: 'selected'; agent: TuiAgent | null; customProfile: CustomAgentProfile | null }

export type ResolveDirectWorkItemAgentArgs = {
  agentOverride?: TuiAgent
  /** Connection the created worktree actually launches on; null when local. */
  launchConnectionId: string | null
  /** Connection `detectedAgentsPromise` was started against, pre-create. */
  repoConnectionId: string | null
  /** In-flight detection kicked off before `createWorktree`; null iff `agentOverride` is set. */
  detectedAgentsPromise: Promise<TuiAgent[]> | null
  latestStore: DetectedAgentsStore
  /** Pre-create settings snapshot the default-preference path reads. */
  settings: GlobalSettings | null | undefined
}

/**
 * Decide which TUI agent a direct work-item launch should start: validate an
 * explicit override against detection, or fall back to the user's default
 * preference (built-in or custom profile) filtered by detection + disabled list.
 */
export async function resolveDirectWorkItemAgent({
  agentOverride,
  launchConnectionId,
  repoConnectionId,
  detectedAgentsPromise,
  latestStore,
  settings
}: ResolveDirectWorkItemAgentArgs): Promise<DirectWorkItemAgentSelection> {
  if (agentOverride) {
    const detectedAgents =
      typeof launchConnectionId === 'string'
        ? await latestStore.ensureRemoteDetectedAgents(launchConnectionId)
        : await latestStore.ensureDetectedAgents()
    if (
      !detectedAgents.includes(agentOverride) ||
      !isTuiAgentEnabled(agentOverride, latestStore.settings?.disabledTuiAgents)
    ) {
      return { kind: 'unavailable' }
    }
    return { kind: 'selected', agent: agentOverride, customProfile: null }
  }

  const detectedAgents =
    launchConnectionId === repoConnectionId
      ? // Why: the pre-create promise is null only when an override is set, which returned above.
        await detectedAgentsPromise!
      : typeof launchConnectionId === 'string'
        ? await latestStore.ensureRemoteDetectedAgents(launchConnectionId)
        : await latestStore.ensureDetectedAgents()
  const detectedIds = new Set(detectedAgents)
  // Why: a custom-profile default participates as its baseAgent; keep the
  // profile only when that base survives detection/disabled filtering.
  const resolvedDefault = resolveDefaultTuiAgentPreference(settings)
  if (
    resolvedDefault.kind === 'custom' &&
    detectedIds.has(resolvedDefault.agent) &&
    isTuiAgentEnabled(resolvedDefault.agent, settings?.disabledTuiAgents)
  ) {
    return {
      kind: 'selected',
      agent: resolvedDefault.agent,
      customProfile: resolvedDefault.profile
    }
  }
  const defaultPref = settings?.defaultTuiAgent
  return {
    kind: 'selected',
    agent: pickTuiAgent(
      defaultPref && typeof defaultPref === 'object' ? null : defaultPref,
      detectedIds,
      settings?.disabledTuiAgents
    ),
    customProfile: null
  }
}
