import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  createClaudeUsageSlice,
  createCodexUsageSlice,
  createOpenCodeUsageSlice
} from './usage-provider-slices'

// Seam introduced by the shared factory: one lifecycle drives each provider's
// PREFIXED state keys (claudeUsage*, codexUsage*, openCodeUsage*) via runtime
// key mapping. These tests drive the real exported factories and assert the
// mapping populates every field for the right provider without leaking across
// prefixes — a class of bug the old literal-key per-provider slices could not
// have.

type StubScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanCompletedAt: number | null
  lastScanError: string | null
  [hasAnyKey: string]: unknown
}

function scanState(hasAnyKey: string): StubScanState {
  return {
    enabled: true,
    isScanning: false,
    lastScanCompletedAt: 200,
    lastScanError: null,
    [hasAnyKey]: true
  }
}

function snapshot(marker: string, state: StubScanState): Record<string, unknown> {
  return {
    scanState: state,
    summary: { marker },
    daily: [{ marker }],
    modelBreakdown: [{ marker }],
    projectBreakdown: [{ marker }],
    recentSessions: [{ marker }]
  }
}

function stubProvider(hasAnyKey: string, marker: string) {
  const state = scanState(hasAnyKey)
  const snap = snapshot(marker, state)
  return {
    getScanState: vi.fn(() => Promise.resolve(state)),
    setEnabled: vi.fn(() => Promise.resolve(state)),
    refresh: vi.fn(() => Promise.resolve(state)),
    getSnapshot: vi.fn(() => Promise.resolve(snap)),
    getSummary: vi.fn(),
    getDaily: vi.fn(),
    getBreakdown: vi.fn(),
    getRecentSessions: vi.fn()
  }
}

function stubAllProviders() {
  const providers = {
    claudeUsage: stubProvider('hasAnyClaudeData', 'claude'),
    codexUsage: stubProvider('hasAnyCodexData', 'codex'),
    openCodeUsage: stubProvider('hasAnyOpenCodeData', 'openCode')
  }
  vi.stubGlobal('window', { api: providers })
  return providers
}

function createAllProvidersStore() {
  return create<AppState>()(
    (...args) =>
      ({
        ...createClaudeUsageSlice(...args),
        ...createCodexUsageSlice(...args),
        ...createOpenCodeUsageSlice(...args)
      }) as AppState
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('shared usage provider slice lifecycle', () => {
  it('seeds each provider prefix with independent initial state', () => {
    stubAllProviders()
    const s = createAllProvidersStore().getState() as unknown as Record<string, unknown>
    for (const prefix of ['claude', 'codex', 'openCode']) {
      expect(s[`${prefix}UsageScope`]).toBe('orca')
      expect(s[`${prefix}UsageRange`]).toBe('30d')
      expect(s[`${prefix}UsageScanState`]).toBeNull()
      expect(s[`${prefix}UsageSummary`]).toBeNull()
      expect(s[`${prefix}UsageDaily`]).toEqual([])
      expect(s[`${prefix}UsageModelBreakdown`]).toEqual([])
      expect(s[`${prefix}UsageProjectBreakdown`]).toEqual([])
      expect(s[`${prefix}UsageRecentSessions`]).toEqual([])
    }
  })

  it('maps every snapshot field onto the claude prefix without leaking to other providers', async () => {
    stubAllProviders()
    const store = createAllProvidersStore()
    await store.getState().fetchClaudeUsage()

    const s = store.getState() as unknown as Record<string, unknown>
    expect(s.claudeUsageScanState).toMatchObject({ enabled: true, hasAnyClaudeData: true })
    expect(s.claudeUsageSummary).toEqual({ marker: 'claude' })
    expect(s.claudeUsageDaily).toEqual([{ marker: 'claude' }])
    expect(s.claudeUsageModelBreakdown).toEqual([{ marker: 'claude' }])
    expect(s.claudeUsageProjectBreakdown).toEqual([{ marker: 'claude' }])
    expect(s.claudeUsageRecentSessions).toEqual([{ marker: 'claude' }])

    // The shared update() must patch only the driven provider's prefix.
    expect(s.codexUsageScanState).toBeNull()
    expect(s.codexUsageSummary).toBeNull()
    expect(s.openCodeUsageScanState).toBeNull()
    expect(s.openCodeUsageSummary).toBeNull()
  })

  it('routes each provider fetch to its own api and prefix', async () => {
    const providers = stubAllProviders()
    const store = createAllProvidersStore()

    await store.getState().fetchCodexUsage()
    await store.getState().fetchOpenCodeUsage()

    expect(providers.claudeUsage.getSnapshot).not.toHaveBeenCalled()
    expect(providers.codexUsage.getSnapshot).toHaveBeenCalled()
    expect(providers.openCodeUsage.getSnapshot).toHaveBeenCalled()

    const s = store.getState() as unknown as Record<string, unknown>
    expect(s.codexUsageSummary).toEqual({ marker: 'codex' })
    expect(s.openCodeUsageSummary).toEqual({ marker: 'openCode' })
    expect(s.claudeUsageSummary).toBeNull()
  })

  it('setScope writes the driven prefix and re-fetches through that provider', async () => {
    const providers = stubAllProviders()
    const store = createAllProvidersStore()

    await store.getState().setClaudeUsageScope('all')

    const s = store.getState() as unknown as Record<string, unknown>
    expect(s.claudeUsageScope).toBe('all')
    expect(s.codexUsageScope).toBe('orca')
    expect(providers.claudeUsage.getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'all', range: '30d' })
    )
  })

  it('clears the driven prefix on disable via setEnabled(false)', async () => {
    const providers = stubAllProviders()
    providers.claudeUsage.setEnabled.mockResolvedValueOnce({
      enabled: false,
      isScanning: false,
      lastScanCompletedAt: 200,
      lastScanError: null,
      hasAnyClaudeData: false
    } as StubScanState)
    const store = createAllProvidersStore()

    await store.getState().fetchClaudeUsage()
    await store.getState().setClaudeUsageEnabled(false)

    const s = store.getState() as unknown as Record<string, unknown>
    expect(s.claudeUsageSummary).toBeNull()
    expect(s.claudeUsageDaily).toEqual([])
    expect(s.claudeUsageScanState).toMatchObject({ enabled: false })
  })
})
