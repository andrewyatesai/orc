import { describe, expect, it } from 'vitest'
import {
  createAgentScratchWorktreePathMatcher,
  isAgentScratchRepoRootPath,
  isAgentScratchWorktreePath
} from './agent-scratch-worktrees'

describe('isAgentScratchWorktreePath', () => {
  const repoPath = '/userhome/dev/app'

  it('matches Claude Code sub-agent worktrees', () => {
    expect(
      isAgentScratchWorktreePath(
        repoPath,
        '/userhome/dev/app/.claude/worktrees/agent-a04ccaaa55ddadb91'
      )
    ).toBe(true)
  })

  it('matches gsd parallel-agent workspaces', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/userhome/dev/app/.gsd-workspaces/phase-1-subagent-2')
    ).toBe(true)
  })

  it('matches scratch worktrees created from a linked checkout', () => {
    const matchesAgentScratch = createAgentScratchWorktreePathMatcher([
      repoPath,
      '/userhome/dev/orca/workspaces/app/feature-x'
    ])

    expect(
      matchesAgentScratch(
        '/userhome/dev/orca/workspaces/app/feature-x/.claude/worktrees/agent-a04ccaaa'
      )
    ).toBe(true)
    expect(
      matchesAgentScratch('/userhome/dev/other/feature-x/.claude/worktrees/agent-a04ccaaa')
    ).toBe(false)
  })

  it('matches Windows path separators and casing', () => {
    expect(
      isAgentScratchWorktreePath(
        'C:\\userhome\\dev\\app',
        'c:\\USERHOME\\dev\\app\\.Claude\\Worktrees\\agent-a04ccaaa'
      )
    ).toBe(true)
  })

  it('matches WSL UNC paths', () => {
    expect(
      isAgentScratchWorktreePath(
        '//wsl$/Ubuntu/home/dev/app',
        '//wsl.localhost/Ubuntu/home/dev/app/.claude/worktrees/agent-a04ccaaa'
      )
    ).toBe(true)
  })

  it('preserves case-sensitive POSIX and WSL tool segments', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/userhome/dev/app/.Claude/Worktrees/agent-a04ccaaa')
    ).toBe(false)
    expect(
      isAgentScratchWorktreePath(
        '//wsl.localhost/Ubuntu/home/dev/app',
        '//wsl.localhost/ubuntu/home/dev/app/.Claude/Worktrees/agent-a04ccaaa'
      )
    ).toBe(false)
  })

  it('requires the tool directory at the repo root', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/userhome/dev/app/.claude/other/worktrees/agent-1')
    ).toBe(false)
    expect(
      isAgentScratchWorktreePath(
        repoPath,
        '/userhome/dev/app/packages/demo/.claude/worktrees/agent-1'
      )
    ).toBe(false)
    expect(isAgentScratchWorktreePath(repoPath, '/userhome/dev/app/.gsd-workspaces')).toBe(false)
  })

  it('does not match undotted claude directories', () => {
    expect(isAgentScratchWorktreePath(repoPath, '/userhome/dev/app/claude/worktrees/agent-1')).toBe(
      false
    )
  })

  it('does not inherit a scratch classification from the repo parent path', () => {
    expect(
      isAgentScratchWorktreePath(
        '/userhome/dev/.claude/worktrees/app',
        '/userhome/dev/.claude/worktrees/app/manual/feature-x'
      )
    ).toBe(false)
  })

  it('does not match user worktree conventions', () => {
    expect(isAgentScratchWorktreePath(repoPath, '/userhome/dev/app/.worktrees/feature-x')).toBe(
      false
    )
    expect(
      isAgentScratchWorktreePath(
        '/userhome/dev/app',
        '/userhome/dev/.superset/worktrees/app/fix-notes'
      )
    ).toBe(false)
    expect(isAgentScratchWorktreePath('/userhome/dev/app', '/orca/workspaces/app/feature')).toBe(
      false
    )
  })
})

describe('isAgentScratchRepoRootPath', () => {
  it('matches codex scratch capsule repos', () => {
    expect(
      isAgentScratchRepoRootPath('/userhome/dev/.codex-tmp/foragent-capsule-b1-repo-zP9Az6')
    ).toBe(true)
    expect(isAgentScratchRepoRootPath('/userhome/dev/.codex-tmp/rc-fwd-qEXuEq')).toBe(true)
  })

  it('matches codex vendor imports and claude skills containers', () => {
    expect(isAgentScratchRepoRootPath('/userhome/dev/.codex/vendor_imports/skills')).toBe(true)
    expect(isAgentScratchRepoRootPath('/userhome/dev/.claude/skills/obsidian-second-brain')).toBe(
      true
    )
  })

  it('matches a repo registered at the scratch container itself', () => {
    expect(isAgentScratchRepoRootPath('/userhome/dev/.codex-tmp')).toBe(true)
    expect(isAgentScratchRepoRootPath('/userhome/dev/.codex/vendor_imports')).toBe(true)
  })

  it('matches scratch worktree containers used as repo roots', () => {
    expect(isAgentScratchRepoRootPath('/userhome/dev/app/.claude/worktrees/agent-a04ccaaa')).toBe(
      true
    )
    expect(isAgentScratchRepoRootPath('/userhome/dev/app/.gsd-workspaces/phase-1')).toBe(true)
  })

  it('matches Windows separators and casing', () => {
    expect(isAgentScratchRepoRootPath('C:\\userhome\\Dev\\.codex-tmp\\Capsule-X')).toBe(true)
    expect(isAgentScratchRepoRootPath('C:\\userhome\\Dev\\.Claude\\Skills\\foo')).toBe(true)
  })

  it('does not match ordinary user repos', () => {
    expect(isAgentScratchRepoRootPath('/userhome/dev/projects/app')).toBe(false)
    expect(isAgentScratchRepoRootPath('/userhome/dev/codex-tmp/app')).toBe(false)
    expect(isAgentScratchRepoRootPath('/userhome/dev/.codex/checkouts/app')).toBe(false)
    expect(isAgentScratchRepoRootPath('/userhome/dev/skills/.claude-app')).toBe(false)
  })

  it('does not match partial multi-segment markers', () => {
    expect(isAgentScratchRepoRootPath('/userhome/dev/.claude/config')).toBe(false)
    expect(isAgentScratchRepoRootPath('/userhome/dev/vendor_imports/app')).toBe(false)
  })
})
