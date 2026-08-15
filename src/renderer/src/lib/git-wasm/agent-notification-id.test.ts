import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildAgentNotificationId } from './agent-notification-id'
import { initGitWasmForTestFromBytes } from './git-line-stats'

// Ported from the deleted src/shared/agent-notification-id.test.ts: the same
// golden id derivation now runs THROUGH the Rust orca-core via wasm. The
// pre-ready sentinel and the numeric edges the codec rejects can only be
// observed here — the parity vectors pin the ready-state goldens.

const preInit = buildAgentNotificationId({
  worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  stateStartedAt: 1780000000123
})

beforeAll(() => {
  initGitWasmForTestFromBytes(readFileSync(new URL('./orca_git_wasm_bg.wasm', import.meta.url)))
})

describe('buildAgentNotificationId wasm wrapper — before ready', () => {
  it('signals not-ready with null (a sentinel: the deleted TS returned an id for this input)', () => {
    expect(preInit).toBeNull()
    // The ready answer proves null is not parity, so both consumers' `if (id)`
    // branches are load-bearing, not incidental null-safety.
    expect(
      buildAgentNotificationId({
        worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        stateStartedAt: 1780000000123
      })
    ).toBe(
      'agent:repo%3A%3A%2Fuserhome%2Fme%2Forca%2Fworkspaces%2Ffeature:tab-1%3A11111111-1111-4111-8111-111111111111:1780000000123'
    )
  })
})

describe('buildAgentNotificationId (orca-core wasm)', () => {
  it('builds a stable id for the same agent event metadata', () => {
    const args = {
      worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      stateStartedAt: 1780000000123
    }

    expect(buildAgentNotificationId(args)).toBe(buildAgentNotificationId(args))
  })

  it('percent-encodes reserved chars and truncates fractional start times', () => {
    expect(
      buildAgentNotificationId({ worktreeId: 'wt/a b&c?', paneKey: 'pane#1', stateStartedAt: 0 })
    ).toBe('agent:wt%2Fa%20b%26c%3F:pane%231:0')
    expect(
      buildAgentNotificationId({
        worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        stateStartedAt: 1780000000456.5
      })
    ).toBe(
      'agent:repo%3A%3A%2Fuserhome%2Fme%2Forca%2Fworkspaces%2Ffeature:tab-1%3A11111111-1111-4111-8111-111111111111:1780000000456'
    )
  })

  it('changes when the agent state start time changes', () => {
    const base = {
      worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
    }

    expect(buildAgentNotificationId({ ...base, stateStartedAt: 1780000000123 })).not.toBe(
      buildAgentNotificationId({ ...base, stateStartedAt: 1780000000456 })
    )
  })

  // The deleted TS ended in String(Math.trunc(x)), so every one of these was '0'.
  // Un-normalized, -0 makes the codec throw inside acknowledgeAgents' Zustand
  // set() (a renderer crash) and -0.5 reaches Rust, whose f64 Display prints '-0'.
  it('renders negative zero and negative fractional start times as the twin did', () => {
    const zeroId = 'agent:w:p:0'
    expect(buildAgentNotificationId({ worktreeId: 'w', paneKey: 'p', stateStartedAt: 0 })).toBe(
      zeroId
    )
    expect(buildAgentNotificationId({ worktreeId: 'w', paneKey: 'p', stateStartedAt: -0 })).toBe(
      zeroId
    )
    expect(buildAgentNotificationId({ worktreeId: 'w', paneKey: 'p', stateStartedAt: -0.5 })).toBe(
      zeroId
    )
  })

  it('returns null for a non-finite start time instead of throwing at the codec', () => {
    expect(
      buildAgentNotificationId({ worktreeId: 'w', paneKey: 'p', stateStartedAt: Number.NaN })
    ).toBeNull()
    expect(
      buildAgentNotificationId({
        worktreeId: 'w',
        paneKey: 'p',
        stateStartedAt: Number.POSITIVE_INFINITY
      })
    ).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    expect(
      buildAgentNotificationId({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        stateStartedAt: 1780000000123
      })
    ).toBeNull()
    expect(
      buildAgentNotificationId({
        worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
        stateStartedAt: 1780000000123
      })
    ).toBeNull()
    expect(
      buildAgentNotificationId({
        worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
      })
    ).toBeNull()
  })
})
