// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store'

// Reachability: prove the real pane constructs the shared UsageTrackingPaneShell
// and that toggling it reaches the store actions — not just the shell in isolation.
const storeMocks = vi.hoisted(() => ({
  fetchCodexUsage: vi.fn(),
  setCodexUsageEnabled: vi.fn(),
  refreshCodexUsage: vi.fn(),
  setCodexUsageScope: vi.fn(),
  setCodexUsageRange: vi.fn(),
  recordFeatureInteraction: vi.fn()
}))

const mockStoreState = {
  codexUsageScanState: {
    enabled: false,
    isScanning: false,
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    lastScanError: null,
    hasAnyCodexData: false
  },
  codexUsageSummary: null,
  codexUsageDaily: [],
  codexUsageModelBreakdown: [],
  codexUsageProjectBreakdown: [],
  codexUsageRecentSessions: [],
  codexUsageScope: 'orca',
  codexUsageRange: '7d',
  fetchCodexUsage: storeMocks.fetchCodexUsage,
  setCodexUsageEnabled: storeMocks.setCodexUsageEnabled,
  refreshCodexUsage: storeMocks.refreshCodexUsage,
  setCodexUsageScope: storeMocks.setCodexUsageScope,
  setCodexUsageRange: storeMocks.setCodexUsageRange,
  recordFeatureInteraction: storeMocks.recordFeatureInteraction
} satisfies Partial<AppState>

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Partial<AppState>) => unknown) => selector(mockStoreState),
    { getState: () => mockStoreState }
  )
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { CodexUsagePane } from './CodexUsagePane'

describe('CodexUsagePane → UsageTrackingPaneShell seam', () => {
  beforeEach(() => {
    storeMocks.fetchCodexUsage.mockResolvedValue(undefined)
    storeMocks.setCodexUsageEnabled.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders the shared shell disabled state and reaches the store toggle action', async () => {
    const user = userEvent.setup()
    render(<CodexUsagePane />)

    expect(
      screen.getByText('Reads local Codex usage logs to show token, model, and session stats.')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Enable Codex usage analytics' }))

    expect(storeMocks.recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    expect(storeMocks.setCodexUsageEnabled).toHaveBeenCalledWith(true)
  })
})
