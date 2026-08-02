// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const INSTALL_COMMAND = 'npx skills add orchestration --global'

const mocks = vi.hoisted(() => ({
  installBundled: vi.fn(),
  notifyInstalledAgentSkillsChanged: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
  terminalCommands: [] as string[]
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyInstalledAgentSkillsChanged
}))

vi.mock('@/components/onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: { command: string }) => {
    mocks.terminalCommands.push(props.command)
    return null
  }
}))

import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'
import { TooltipProvider } from '@/components/ui/tooltip'
import { bundledSkillOfflineInstallPanelProps } from './bundled-skill-offline-install'

/**
 * The behavioral anchor under `bundled-skill-install-cta-completeness.test.ts`.
 *
 * That test proves each CTA calls this factory; only a real click proves the factory's
 * props install anything. Both halves are needed: neither a parsed call nor a mocked
 * `offlineInstall` can tell a live rail from one whose IPC was quietly removed.
 */
describe('a panel built by the offline factory installs from the bundle when clicked', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  async function renderPanel(supported: boolean): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AgentSkillSetupPanel, {
            title: 'Orchestration skill',
            description: 'Runs agents in parallel.',
            command: INSTALL_COMMAND,
            terminalTitle: 'Orchestration setup',
            terminalAriaLabel: 'Orchestration install terminal',
            terminalWorktreeId: 'offline-install-anchor',
            installed: false,
            loading: false,
            error: null,
            onRecheck: vi.fn(),
            ...bundledSkillOfflineInstallPanelProps({
              supported,
              names: ['orchestration'],
              skillLabel: 'the orchestration skill'
            })
          })
        )
      )
    })
    await act(async () => {})
  }

  async function clickInstall(): Promise<void> {
    const button = [...(container?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim() === 'Install'
    )
    expect(button).toBeDefined()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})
  }

  beforeEach(() => {
    mocks.installBundled.mockReset()
    mocks.notifyInstalledAgentSkillsChanged.mockReset()
    mocks.terminalCommands.length = 0
    for (const toast of Object.values(mocks.toast)) {
      toast.mockReset()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: {
          getInstallStatus: vi.fn(async () => ({ state: 'installed', pathConfigured: true }))
        },
        skills: { installBundled: mocks.installBundled },
        ui: { writeClipboardText: vi.fn() }
      }
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    Reflect.deleteProperty(window, 'api')
  })

  it('invokes the bundled-install IPC instead of opening a terminal', async () => {
    mocks.installBundled.mockResolvedValue([
      { name: 'orchestration', outcome: 'installed', reason: null, placements: [] }
    ])

    await renderPanel(true)
    await clickInstall()

    expect(mocks.installBundled).toHaveBeenCalledWith(['orchestration'])
    expect(mocks.notifyInstalledAgentSkillsChanged).toHaveBeenCalledTimes(1)
    expect(mocks.terminalCommands).toEqual([])
  })

  it('falls back to the command terminal when the offline rail cannot serve the runtime', async () => {
    await renderPanel(false)
    await clickInstall()

    expect(mocks.installBundled).not.toHaveBeenCalled()
    expect(mocks.terminalCommands).toEqual([INSTALL_COMMAND])
  })
})
