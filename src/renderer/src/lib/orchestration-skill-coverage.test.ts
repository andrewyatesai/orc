import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../shared/skills'
import type { TuiAgent } from '../../../shared/types'
import {
  agentHasOrchestrationSkill,
  getOrchestrationSkillAgentStatuses
} from './orchestration-skill-coverage'

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'skill-1',
    name: 'orchestration',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/userhome/test/.agents/skills',
    directoryPath: '/userhome/test/.agents/skills/orchestration',
    skillFilePath: '/userhome/test/.agents/skills/orchestration/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

function source(
  path: string,
  owner: SkillDiscoverySource['owner'],
  sourceKind: SkillDiscoverySource['sourceKind'] = 'home'
): SkillDiscoverySource {
  return {
    id: path,
    label: path,
    path,
    sourceKind,
    providers: ['agent-skills'],
    owner,
    exists: true
  }
}

describe('orchestration skill agent coverage', () => {
  it('marks shared-path agents from the global ~/.agents/skills install', () => {
    const skills = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.agents/skills',
        directoryPath: '/userhome/test/.agents/skills/orchestration'
      })
    ]

    expect(
      getOrchestrationSkillAgentStatuses(
        skills,
        ['codex', 'gemini', 'droid'],
        [source('/userhome/test/.agents/skills', null)]
      )
    ).toEqual([
      { agent: 'codex', label: 'Codex', installed: true },
      { agent: 'gemini', label: 'Gemini', installed: true },
      { agent: 'droid', label: 'Droid', installed: true }
    ])
  })

  it('marks Claude from ~/.claude/skills without requiring a dedicated Codex path', () => {
    const skills = [
      skill({
        providers: ['claude'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.claude/skills',
        directoryPath: '/userhome/test/.claude/skills/orchestration'
      })
    ]

    const sources = [source('/userhome/test/.claude/skills', 'claude')]
    expect(agentHasOrchestrationSkill('claude', skills, sources)).toBe(true)
    expect(agentHasOrchestrationSkill('codex', skills, sources)).toBe(false)
    expect(agentHasOrchestrationSkill('gemini', skills, sources)).toBe(false)
  })

  it('marks Codex from plugin cache installs', () => {
    expect(
      agentHasOrchestrationSkill(
        'codex',
        [
          skill({
            providers: ['codex', 'agent-skills'],
            sourceKind: 'plugin',
            sourceLabel: 'Codex plugin cache',
            rootPath: '/userhome/test/.codex/plugins/cache',
            directoryPath: '/userhome/test/.codex/plugins/cache/vendor/orchestration'
          })
        ],
        [source('/userhome/test/.codex/plugins/cache', 'codex', 'plugin')]
      )
    ).toBe(true)
  })

  it('marks Claude from an enabled plugin install', () => {
    // Why: Claude Code loads skills from enabled plugins, so an owned plugin root
    // counts the same as the Codex plugin cache does.
    expect(
      agentHasOrchestrationSkill(
        'claude',
        [
          skill({
            providers: ['claude', 'agent-skills'],
            sourceKind: 'plugin',
            sourceLabel: 'Claude plugin',
            rootPath: '/userhome/test/.claude/plugins/repos/vendor/pack/skills',
            directoryPath: '/userhome/test/.claude/plugins/repos/vendor/pack/skills/orchestration'
          })
        ],
        [source('/userhome/test/.claude/plugins/repos/vendor/pack/skills', 'claude', 'plugin')]
      )
    ).toBe(true)
  })

  it('ignores repo-scoped orchestration installs', () => {
    expect(
      agentHasOrchestrationSkill(
        'gemini',
        [
          skill({
            providers: ['agent-skills'],
            sourceKind: 'repo',
            rootPath: '/workspace/.agents/skills',
            directoryPath: '/workspace/.agents/skills/orchestration'
          })
        ],
        [source('/workspace/.agents/skills', null, 'repo')]
      )
    ).toBe(false)
  })

  it('matches orchestration by directory name when frontmatter uses a display name', () => {
    expect(
      agentHasOrchestrationSkill(
        'claude',
        [
          skill({
            name: 'Orca Orchestration',
            providers: ['claude'],
            sourceKind: 'home',
            rootPath: '/userhome/test/.claude/skills',
            directoryPath: '/userhome/test/.claude/skills/orchestration'
          })
        ],
        [source('/userhome/test/.claude/skills', 'claude')]
      )
    ).toBe(true)
  })

  it('marks each provider-home agent from its own global skills location', () => {
    const cases: { agent: TuiAgent; rootPath: string; directoryPath: string }[] = [
      {
        agent: 'grok',
        rootPath: '/userhome/test/.grok/skills',
        directoryPath: '/userhome/test/.grok/skills/orchestration'
      },
      {
        agent: 'opencode',
        rootPath: '/userhome/test/.config/opencode/skills',
        directoryPath: '/userhome/test/.config/opencode/skills/orchestration'
      },
      {
        agent: 'pi',
        rootPath: '/userhome/test/.pi/agent/skills',
        directoryPath: '/userhome/test/.pi/agent/skills/orchestration'
      },
      {
        agent: 'gemini',
        rootPath: '/userhome/test/.gemini/skills',
        directoryPath: '/userhome/test/.gemini/skills/orchestration'
      },
      {
        agent: 'antigravity',
        rootPath: '/userhome/test/.gemini/antigravity/skills',
        directoryPath: '/userhome/test/.gemini/antigravity/skills/orchestration'
      },
      {
        agent: 'cursor',
        rootPath: '/userhome/test/.cursor/skills',
        directoryPath: '/userhome/test/.cursor/skills/orchestration'
      }
    ]
    for (const { agent, rootPath, directoryPath } of cases) {
      const skills = [
        skill({ providers: ['agent-skills'], sourceKind: 'home', rootPath, directoryPath })
      ]
      const sources = [source(rootPath, agent)]
      expect(agentHasOrchestrationSkill(agent, skills, sources)).toBe(true)
      // Why: a provider-home install must not leak coverage to unrelated agents.
      expect(agentHasOrchestrationSkill('claude', skills, sources)).toBe(false)
    }
  })

  it('marks every provider root retained after symlink deduplication', () => {
    // Why: `npx skills add --global` symlinks provider homes onto one install, so
    // dedup collapses them to a single row whose absorbed roots live in `rootPaths`.
    const roots = [
      source('/userhome/test/.codex/skills', 'codex'),
      source('/userhome/test/.claude/skills', 'claude'),
      source('/userhome/test/.grok/skills', 'grok'),
      source('/userhome/test/.config/opencode/skills', 'opencode'),
      source('/userhome/test/.pi/agent/skills', 'pi'),
      source('/userhome/test/.omp/agent/skills', 'omp'),
      source('/userhome/test/.gemini/skills', 'gemini'),
      source('/userhome/test/.gemini/antigravity/skills', 'antigravity'),
      source('/userhome/test/.cursor/skills', 'cursor')
    ]
    const skills = [
      skill({
        providers: ['codex', 'claude', 'agent-skills'],
        rootPath: roots[0].path,
        rootPaths: roots.map((root) => root.path),
        directoryPath: '/userhome/test/.codex/skills/orchestration'
      })
    ]

    expect(
      getOrchestrationSkillAgentStatuses(
        skills,
        [
          'codex',
          'claude',
          'claude-agent-teams',
          'grok',
          'opencode',
          'pi',
          'omp',
          'gemini',
          'antigravity',
          'cursor'
        ],
        roots
      ).every((status) => status.installed)
    ).toBe(true)
  })

  it('does not treat a repository shared root as a global install after deduplication', () => {
    const codexRoot = source('/userhome/test/.codex/skills', 'codex')
    const repoRoot = source('/workspace/.agents/skills', null, 'repo')
    const skills = [
      skill({
        providers: ['codex', 'agent-skills'],
        rootPath: codexRoot.path,
        rootPaths: [codexRoot.path, repoRoot.path],
        directoryPath: '/userhome/test/.codex/skills/orchestration'
      })
    ]

    expect(agentHasOrchestrationSkill('codex', skills, [codexRoot, repoRoot])).toBe(true)
    expect(agentHasOrchestrationSkill('grok', skills, [codexRoot, repoRoot])).toBe(false)
  })

  it('keeps the owning home root when a repo root duplicates its path', () => {
    // Why: a workspace whose cwd is the home dir scans ~/.claude/skills as both a
    // home and a repo root, and keying sources by path would let the repo shadow it.
    const skills = [
      skill({
        providers: ['claude'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.claude/skills',
        directoryPath: '/userhome/test/.claude/skills/orchestration'
      })
    ]

    expect(
      agentHasOrchestrationSkill('claude', skills, [
        source('/userhome/test/.claude/skills', 'claude'),
        source('/userhome/test/.claude/skills', 'claude', 'repo')
      ])
    ).toBe(true)
  })

  it('leaves an agent uncovered when no source claims the skill root', () => {
    const skills = [
      skill({
        providers: ['claude'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.claude/skills',
        directoryPath: '/userhome/test/.claude/skills/orchestration'
      })
    ]

    expect(agentHasOrchestrationSkill('claude', skills, [])).toBe(false)
  })

  it('marks OpenClaude from ~/.claude/skills like Claude Code', () => {
    const skills = [
      skill({
        providers: ['claude'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.claude/skills',
        directoryPath: '/userhome/test/.claude/skills/orchestration'
      })
    ]

    expect(
      agentHasOrchestrationSkill('openclaude', skills, [
        source('/userhome/test/.claude/skills', 'claude')
      ])
    ).toBe(true)
  })

  it('marks a multi-segment provider-home agent from a Windows-style path', () => {
    expect(
      agentHasOrchestrationSkill(
        'opencode',
        [
          skill({
            providers: ['agent-skills'],
            sourceKind: 'home',
            rootPath: 'C:\\userhome\\test\\.config\\opencode\\skills',
            directoryPath: 'C:\\userhome\\test\\.config\\opencode\\skills\\orchestration'
          })
        ],
        [source('C:\\userhome\\test\\.config\\opencode\\skills', 'opencode')]
      )
    ).toBe(true)
  })

  it('keeps Pi and OMP distinct despite sharing the <home>/agent/skills shape', () => {
    const piInstall = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.pi/agent/skills',
        directoryPath: '/userhome/test/.pi/agent/skills/orchestration'
      })
    ]
    const ompInstall = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.omp/agent/skills',
        directoryPath: '/userhome/test/.omp/agent/skills/orchestration'
      })
    ]

    const piSources = [source('/userhome/test/.pi/agent/skills', 'pi')]
    const ompSources = [source('/userhome/test/.omp/agent/skills', 'omp')]
    expect(agentHasOrchestrationSkill('pi', piInstall, piSources)).toBe(true)
    expect(agentHasOrchestrationSkill('omp', piInstall, piSources)).toBe(false)
    expect(agentHasOrchestrationSkill('omp', ompInstall, ompSources)).toBe(true)
    expect(agentHasOrchestrationSkill('pi', ompInstall, ompSources)).toBe(false)
  })

  it('keeps Gemini and Antigravity distinct despite sharing the ~/.gemini root', () => {
    const geminiInstall = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.gemini/skills',
        directoryPath: '/userhome/test/.gemini/skills/orchestration'
      })
    ]
    const antigravityInstall = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.gemini/antigravity/skills',
        directoryPath: '/userhome/test/.gemini/antigravity/skills/orchestration'
      })
    ]

    const geminiSources = [source('/userhome/test/.gemini/skills', 'gemini')]
    const antigravitySources = [source('/userhome/test/.gemini/antigravity/skills', 'antigravity')]
    expect(agentHasOrchestrationSkill('gemini', geminiInstall, geminiSources)).toBe(true)
    expect(agentHasOrchestrationSkill('antigravity', geminiInstall, geminiSources)).toBe(false)
    expect(agentHasOrchestrationSkill('antigravity', antigravityInstall, antigravitySources)).toBe(
      true
    )
    expect(agentHasOrchestrationSkill('gemini', antigravityInstall, antigravitySources)).toBe(false)
  })

  it('marks Claude Agent Teams from ~/.claude/skills like Claude Code', () => {
    const skills = [
      skill({
        providers: ['claude'],
        sourceKind: 'home',
        rootPath: '/userhome/test/.claude/skills',
        directoryPath: '/userhome/test/.claude/skills/orchestration'
      })
    ]

    expect(
      agentHasOrchestrationSkill('claude-agent-teams', skills, [
        source('/userhome/test/.claude/skills', 'claude')
      ])
    ).toBe(true)
  })

  it('marks Windows skill paths', () => {
    expect(
      agentHasOrchestrationSkill(
        'codex',
        [
          skill({
            providers: ['codex'],
            sourceKind: 'home',
            rootPath: 'C:\\userhome\\test\\.codex\\skills',
            directoryPath: 'C:\\userhome\\test\\.codex\\skills\\orchestration'
          })
        ],
        [source('C:\\userhome\\test\\.codex\\skills', 'codex')]
      )
    ).toBe(true)
  })
})
