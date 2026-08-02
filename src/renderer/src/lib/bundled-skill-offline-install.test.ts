// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult } from '../../../shared/bundled-skill-install'

const mocks = vi.hoisted(() => ({
  installBundled: vi.fn(),
  notifyInstalledAgentSkillsChanged: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning
  }
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyInstalledAgentSkillsChanged
}))

import {
  installBundledSkillsOffline,
  summarizeBundledSkillInstall
} from './bundled-skill-offline-install'

function result(overrides: Partial<BundledSkillInstallResult>): BundledSkillInstallResult {
  return {
    name: 'orchestration',
    outcome: 'installed',
    reason: null,
    placements: [],
    ...overrides
  }
}

function install(): Promise<boolean> {
  return installBundledSkillsOffline({
    names: ['orchestration'],
    skillLabel: 'the orchestration skill'
  })
}

describe('bundled skill offline install', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { installBundled: mocks.installBundled } }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('reports the outcome that still needs a human ahead of a sibling write', () => {
    const summary = summarizeBundledSkillInstall([
      result({ name: 'orca-cli', outcome: 'installed' }),
      result({ outcome: 'refused-user-owned', reason: 'refused-unrecognized: edited' })
    ])

    expect(summary?.outcome).toBe('refused-user-owned')
  })

  it('completes without a terminal and refreshes detection when the payload lands', async () => {
    mocks.installBundled.mockResolvedValue([result({ outcome: 'installed' })])

    await expect(install()).resolves.toBe(true)
    expect(mocks.installBundled).toHaveBeenCalledWith(['orchestration'])
    expect(mocks.notifyInstalledAgentSkillsChanged).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Installed the orchestration skill from this app build.'
    )
  })

  it('treats an already-current package as done rather than a silent no-op', async () => {
    mocks.installBundled.mockResolvedValue([result({ outcome: 'already-current' })])

    await expect(install()).resolves.toBe(true)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('No update needed for the orchestration skill.')
  })

  it('hands a name the npx updater owns back to the terminal rail', async () => {
    mocks.installBundled.mockResolvedValue([result({ outcome: 'deferred-to-npx' })])

    await expect(install()).resolves.toBe(false)
    expect(mocks.notifyInstalledAgentSkillsChanged).not.toHaveBeenCalled()
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'The skills CLI manages the orchestration skill.',
      expect.objectContaining({ description: 'Opening a terminal to finish the install.' })
    )
  })

  // Why: the terminal rail runs `npx skills add --global` — the one command that would
  // overwrite the copy we just declined to touch. Offering it here made the clobber the
  // obvious next click, directly under a toast promising nothing was overwritten.
  it('points at the user’s own copy instead of offering the command that would clobber it', async () => {
    mocks.installBundled.mockResolvedValue([
      result({
        outcome: 'refused-user-owned',
        reason: 'refused-unrecognized: edited',
        placements: [
          {
            rootId: 'home-claude',
            sourceLabel: 'Claude home',
            packagePath: '/home/.claude/skills/orchestration',
            state: 'refused-unrecognized',
            detail: null
          }
        ]
      })
    ])

    await expect(install()).resolves.toBe(false)
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'Orca kept your own copy of the orchestration skill.',
      expect.objectContaining({
        description:
          'Nothing was overwritten. Your copy at /home/.claude/skills/orchestration stays in charge until you move it aside.',
        action: expect.objectContaining({ label: 'Show my copy' })
      })
    )
  })

  it('falls back to the terminal when no agent home was detected', async () => {
    mocks.installBundled.mockResolvedValue([
      result({ outcome: 'failed', reason: 'no-detected-agent-home' })
    ])

    await expect(install()).resolves.toBe(false)
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not install the orchestration skill from this app build.',
      expect.objectContaining({ description: 'Opening a terminal to finish the install.' })
    )
  })

  it('falls back to the terminal when the install channel itself rejects', async () => {
    mocks.installBundled.mockRejectedValue(new Error('ipc channel closed'))

    await expect(install()).resolves.toBe(false)
    expect(mocks.notifyInstalledAgentSkillsChanged).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not install the orchestration skill from this app build.',
      expect.objectContaining({ description: 'ipc channel closed' })
    )
  })
})
