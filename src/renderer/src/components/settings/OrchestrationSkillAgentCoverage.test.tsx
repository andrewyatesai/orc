import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'codex'],
    isLoading: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

describe('OrchestrationSkillAgentCoverage', () => {
  it('shows each detected agent with an explicit skill status', () => {
    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        skills={[
          {
            id: 'claude-skill',
            name: 'orchestration',
            description: null,
            providers: ['claude'],
            sourceKind: 'home',
            sourceLabel: 'Claude home',
            rootPath: '/userhome/test/.claude/skills',
            directoryPath: '/userhome/test/.claude/skills/orchestration',
            skillFilePath: '/userhome/test/.claude/skills/orchestration/SKILL.md',
            installed: true,
            fileCount: 1,
            updatedAt: null
          }
        ]}
      />
    )

    expect(markup).toContain('Claude')
    expect(markup).toContain('Codex')
    expect(markup).toContain('Ready')
    expect(markup).toContain('Missing')
    expect(markup).not.toContain('View details')
  })
})
