import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { TuiAgent } from '../../../../shared/types'
import {
  EMPTY_AUTOMATION_AGENT_FILTER,
  filterByAutomationAgentFilter,
  isAutomationAgentFilterActive,
  toggleAutomationAgentFilter
} from './automation-agent-filter'

function makeAutomation(id: string, agentId: TuiAgent): Pick<Automation, 'id' | 'agentId'> {
  return { id, agentId }
}

describe('automation-agent-filter', () => {
  it('treats the empty filter as inactive and passes every row through', () => {
    const rows = [makeAutomation('codex-job', 'codex'), { id: 'external-1', agentId: null }]
    expect(isAutomationAgentFilterActive(EMPTY_AUTOMATION_AGENT_FILTER)).toBe(false)
    expect(filterByAutomationAgentFilter(rows, EMPTY_AUTOMATION_AGENT_FILTER)).toEqual(rows)
  })

  it('filters local rows by multiple agents and leaves external rows out of agent scope', () => {
    const rows = [
      makeAutomation('codex-job', 'codex'),
      makeAutomation('claude-job', 'claude'),
      makeAutomation('hermes-job', 'hermes'),
      { id: 'external-1', agentId: null }
    ]
    const filtered = filterByAutomationAgentFilter(rows, ['codex', 'claude'])
    expect(filtered.map((row) => row.id)).toEqual(['codex-job', 'claude-job'])
    expect(isAutomationAgentFilterActive(['codex', 'claude'])).toBe(true)
  })

  it('toggles an agent in and back out of the selected set', () => {
    const added = toggleAutomationAgentFilter(EMPTY_AUTOMATION_AGENT_FILTER, 'codex')
    expect(added).toEqual(['codex'])
    expect(toggleAutomationAgentFilter(added, 'codex')).toEqual([])
    expect(toggleAutomationAgentFilter(added, 'claude')).toEqual(['codex', 'claude'])
  })
})
