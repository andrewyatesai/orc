import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HttpLinkRouting from '@/lib/http-link-routing'

const { openHttpLinkMock } = vi.hoisted(() => ({ openHttpLinkMock: vi.fn() }))
vi.mock('@/lib/http-link-routing', async (importActual) => ({
  ...(await importActual<typeof HttpLinkRouting>()),
  openHttpLink: openHttpLinkMock
}))

import { openTerminalHttpLink } from './terminal-url-link-hit-testing'

afterEach(() => {
  openHttpLinkMock.mockReset()
})

describe('openTerminalHttpLink sourceOwner threading', () => {
  it('forwards a runtime owner and suppresses the in-app preference prompt', () => {
    const requestOpenLinksInAppPreference = vi.fn().mockReturnValue(true)

    openTerminalHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
      requestOpenLinksInAppPreference
    })

    // Why: a runtime-hosted link can only reach the system browser, so the
    // preference dialog (which persists an in-app choice) must never open.
    expect(requestOpenLinksInAppPreference).not.toHaveBeenCalled()
    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })
  })

  it('forwards an SSH owner on a forced-system-browser click', () => {
    openTerminalHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      forceSystemBrowser: true,
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' }
    })

    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/', {
      worktreeId: 'wt-1',
      forceSystemBrowser: true,
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' }
    })
  })

  it('still prompts and defaults to a local owner when none is supplied', () => {
    const requestOpenLinksInAppPreference = vi.fn().mockReturnValue(null)

    openTerminalHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      requestOpenLinksInAppPreference
    })

    expect(requestOpenLinksInAppPreference).toHaveBeenCalledWith('https://example.com/')
    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' }
    })
  })
})
