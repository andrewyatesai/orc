// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeUsageSessionRow } from '../../../../shared/claude-usage-types'
import type { CodexUsageSessionRow } from '../../../../shared/codex-usage-types'
import type { OpenCodeUsageSessionRow } from '../../../../shared/opencode-usage-types'

// Reachability: render the real *UsageDetails production components so the
// assertions prove those panes actually wire the shared UsageRecentSessionsTable
// with each provider's activity/trailing/model-suffix adapters — not the shared
// table constructed in isolation.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { ClaudeUsageDetails } from './ClaudeUsageDetails'
import { CodexUsageDetails } from './CodexUsageDetails'
import { OpenCodeUsageDetails } from './OpenCodeUsageDetails'

const claudeRow: ClaudeUsageSessionRow = {
  sessionId: 'c1',
  lastActiveAt: '2026-08-10T18:00:00.000Z',
  durationMinutes: 12,
  projectLabel: 'orca',
  branch: 'main',
  model: 'claude-opus',
  turns: 7,
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 1000,
  cacheWriteTokens: 500
}

const codexRow: CodexUsageSessionRow = {
  sessionId: 'x1',
  lastActiveAt: '2026-08-10T18:00:00.000Z',
  durationMinutes: 5,
  projectLabel: 'orca',
  model: 'gpt-5-codex',
  events: 42,
  inputTokens: 100,
  cachedInputTokens: 10,
  outputTokens: 200,
  reasoningOutputTokens: 5,
  totalTokens: 3000,
  hasInferredPricing: true
}

const openCodeRow: OpenCodeUsageSessionRow = {
  sessionId: 'o1',
  lastActiveAt: '2026-08-10T18:00:00.000Z',
  durationMinutes: 5,
  projectLabel: 'orca',
  model: 'opencode-model',
  events: 9,
  inputTokens: 100,
  cachedInputTokens: 10,
  outputTokens: 200,
  reasoningOutputTokens: 5,
  totalTokens: 4200
}

describe('*UsageDetails → UsageRecentSessionsTable seam', () => {
  afterEach(cleanup)

  it('Claude wires the Turns activity + cache-read/write trailing adapters', () => {
    render(
      <ClaudeUsageDetails
        daily={[]}
        modelBreakdown={[]}
        projectBreakdown={[]}
        recentSessions={[claudeRow]}
        summary={null}
      />
    )

    expect(screen.getByRole('columnheader', { name: 'Turns' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Cache' })).toBeInTheDocument()
    // getActivity(row) === row.turns
    expect(screen.getByRole('cell', { name: '7' })).toBeInTheDocument()
    // getTrailingTokens(row) === cacheReadTokens + cacheWriteTokens === 1500 -> "1.5k"
    expect(screen.getByRole('cell', { name: '1.5k' })).toBeInTheDocument()
    expect(screen.getByText(/Cache reuse rate:/)).toBeInTheDocument()
  })

  it('Codex wires the Events activity, Total trailing, and inferred-pricing model suffix', () => {
    render(
      <CodexUsageDetails
        daily={[]}
        modelBreakdown={[]}
        projectBreakdown={[]}
        recentSessions={[codexRow]}
        summary={null}
      />
    )

    expect(screen.getByRole('columnheader', { name: 'Events' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '42' })).toBeInTheDocument()
    // getModelSuffix appends " *" when hasInferredPricing
    expect(screen.getByRole('cell', { name: 'gpt-5-codex *' })).toBeInTheDocument()
    expect(screen.getByText('Most recent local Codex sessions in this scope.')).toBeInTheDocument()
  })

  it('OpenCode wires the Events activity with no model suffix', () => {
    render(
      <OpenCodeUsageDetails
        daily={[]}
        modelBreakdown={[]}
        projectBreakdown={[]}
        recentSessions={[openCodeRow]}
        summary={null}
      />
    )

    expect(screen.getByRole('columnheader', { name: 'Events' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '9' })).toBeInTheDocument()
    // No getModelSuffix wired -> model renders verbatim, no trailing " *"
    expect(screen.getByRole('cell', { name: 'opencode-model' })).toBeInTheDocument()
    expect(
      screen.getByText('Most recent local OpenCode sessions in this scope.')
    ).toBeInTheDocument()
  })
})
