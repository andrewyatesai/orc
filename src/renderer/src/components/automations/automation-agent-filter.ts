import type { TuiAgent } from '../../../../shared/types'

// A selected set of agents; empty means "no agent filter applied".
export type AutomationAgentFilter = readonly TuiAgent[]

export const EMPTY_AUTOMATION_AGENT_FILTER: AutomationAgentFilter = []

export function isAutomationAgentFilterActive(filter: AutomationAgentFilter): boolean {
  return filter.length > 0
}

export function toggleAutomationAgentFilter(
  filter: AutomationAgentFilter,
  agentId: TuiAgent
): TuiAgent[] {
  return filter.includes(agentId)
    ? filter.filter((selected) => selected !== agentId)
    : [...filter, agentId]
}

// An active filter keeps only rows whose agent is selected; rows with no agent
// (external automations) fall out of agent scope entirely, matching upstream.
export function filterByAutomationAgentFilter<T extends { agentId: TuiAgent | null }>(
  items: readonly T[],
  filter: AutomationAgentFilter
): T[] {
  if (filter.length === 0) {
    return [...items]
  }
  return items.filter((item) => item.agentId !== null && filter.includes(item.agentId))
}
