import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSessionDeleteBlockedReason } from './ai-vault-session-deletability'

type DeletabilityInput = Pick<AiVaultSession, 'agent' | 'executionHostId' | 'filePath'>

describe('aiVaultSessionDeleteBlockedReason', () => {
  it('offers Delete (null reason) for a local single-file deletable agent', () => {
    const session: DeletabilityInput = {
      agent: 'gemini',
      executionHostId: 'local',
      filePath: '/home/me/.gemini/tmp/session.json'
    }
    expect(aiVaultSessionDeleteBlockedReason(session)).toBeNull()
  })

  it('blocks a non-local (SSH/runtime) session before anything else', () => {
    // Even a deletable agent is blocked: the path exists on the remote host.
    const session: DeletabilityInput = {
      agent: 'gemini',
      executionHostId: 'ssh:box',
      filePath: '/home/me/.gemini/tmp/session.json'
    }
    expect(aiVaultSessionDeleteBlockedReason(session)).toBe(
      'Only sessions on this device can be deleted.'
    )
  })

  it('blocks a synthetic OpenCode-SQLite identity path', () => {
    const session: DeletabilityInput = {
      agent: 'opencode',
      executionHostId: 'local',
      filePath: '/home/me/.local/share/opencode/db.sqlite#session-1'
    }
    expect(aiVaultSessionDeleteBlockedReason(session)).toBe(
      "This session can't be deleted from Orca."
    )
  })

  it('blocks a registry-backed unsupported agent on a local real path', () => {
    const session: DeletabilityInput = {
      agent: 'codex',
      executionHostId: 'local',
      filePath: '/home/me/.codex/sessions/2026/session.jsonl'
    }
    const reason = aiVaultSessionDeleteBlockedReason(session)
    expect(reason).not.toBeNull()
    // Renderer-blocked is a subset of main-blocked: codex is excluded from the
    // shared deletable set, so this can never read as offered.
    expect(reason).toContain('Codex')
  })
})
