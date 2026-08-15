// @vitest-environment happy-dom

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'
import { VaultSessionRow } from './AiVaultSessionRow'

const session = {
  id: 'local:gemini:sess-1:/home/a/.gemini/s.json',
  executionHostId: 'local',
  agent: 'gemini',
  sessionId: 'sess-1',
  title: 'A session',
  cwd: null,
  branch: null,
  model: null,
  filePath: '/home/a/.gemini/s.json',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: 0,
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [{ role: 'assistant', text: 'Ready when you are' }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'gemini --resume sess-1',
  subagent: null
} as unknown as AiVaultSession

const worktreeInfo: AiVaultSessionWorktreeInfo = {
  status: 'active',
  label: 'feature-branch',
  path: '/home/a/worktrees/feature-branch'
}

beforeEach(() => {
  // The expanded details panel's subagent section reads this on mount; the row
  // cannot expand without it even though this fixture lists zero subagents.
  ;(window as unknown as { api: unknown }).api = {
    aiVault: {
      getFirstUserPrompt: vi.fn().mockResolvedValue({ prompt: null }),
      listSubagentSessions: vi.fn().mockResolvedValue({ sessions: [] })
    }
  }
})

afterEach(() => {
  // No `globals: true`, so Testing Library's auto-cleanup never runs and rows
  // from earlier tests would stay in the document and duplicate every query.
  cleanup()
  vi.clearAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

function renderRow(
  overrides: {
    detailsExpanded?: boolean
    worktreeInfo?: AiVaultSessionWorktreeInfo | null
  } = {}
) {
  return render(
    <TooltipProvider>
      <VaultSessionRow
        session={session}
        liveState={null}
        resumeStartup={{ command: 'gemini --resume sess-1' }}
        realHomeResumeStartup={{ command: 'gemini --resume sess-1' }}
        worktreeInfo={overrides.worktreeInfo ?? null}
        vaultScope="all"
        detailsExpanded={overrides.detailsExpanded ?? false}
        resumeDisabled={false}
        onToggleDetails={vi.fn()}
        showJumpToWorktree={false}
        onResume={vi.fn()}
        resumeLabel="Resume in New Tab"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
      />
    </TooltipProvider>
  )
}

function expectAgentIdentity(): void {
  const metadata = screen.getByTestId('ai-vault-session-metadata')
  // AgentIcon is an <svg> for the hand-drawn agents and an <img> for the rest.
  expect(metadata.querySelector('svg, img')).toBeTruthy()
  expect(within(metadata).getByText('Gemini')).toBeTruthy()
  expect(within(metadata).getByText('2 msgs')).toBeTruthy()
}

describe('VaultSessionRow agent metadata line', () => {
  it('shows the agent identity when the row is collapsed', () => {
    renderRow()

    expectAgentIdentity()
    expect(screen.getByText(': Ready when you are')).toBeTruthy()
  })

  it('keeps the agent identity visible while the row is expanded', () => {
    // The regression: SessionMetadata used to live inside the collapsed-only
    // branch, so expanding the row dropped the agent header entirely.
    renderRow({ detailsExpanded: true })

    expectAgentIdentity()
    // The details panel replaces the one-line preview with the full turns.
    expect(screen.getByText('Latest turns')).toBeTruthy()
    expect(screen.queryByText(': Ready when you are')).toBeNull()
  })

  it('renders the worktree badge once when expanded', () => {
    // The metadata grid already carries the worktree badge, so the row body must
    // not add a second copy of its own above the details panel.
    const { container } = renderRow({ detailsExpanded: true, worktreeInfo })

    expect(container.querySelectorAll(`[title="${worktreeInfo.label}"]`)).toHaveLength(1)
  })
})
