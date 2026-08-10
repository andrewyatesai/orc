import { describe, expect, it, vi } from 'vitest'
import { RuntimeBrowserCommands } from './orca-runtime-browser'
import { CallerScopeDeniedError, runWithCallerScope } from './runtime-caller-scope'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const REMOTE = { kind: 'ssh', connectionId: 'ssh_target_a' } as const

function createCommands(): RuntimeBrowserCommands {
  return new RuntimeBrowserCommands({
    // Why: reaching any of these would mean the refusal came too late.
    getAgentBrowserBridge: () => {
      throw new Error('remote callers must not reach the browser bridge')
    },
    resolveWorktreeSelector: async () => {
      throw new Error('remote callers must not reach browser target resolution')
    },
    getAuthoritativeWindow: () => {
      throw new Error('unreachable')
    },
    getAvailableAuthoritativeWindow: () => null,
    getOffscreenBrowserBackend: () => null
  } as never)
}

describe('browser eval/exec are refused for remote callers', () => {
  it('refuses eval — arbitrary JS in the laptop browser profile, with no host to bound', async () => {
    await expect(
      runWithCallerScope(REMOTE, () => createCommands().browserEval({ expression: '1+1' }))
    ).rejects.toThrow(/browser eval .* no host selector to bound/)
  })

  it('refuses exec', async () => {
    await expect(
      runWithCallerScope(REMOTE, () => createCommands().browserExec({ command: 'Page.navigate' }))
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('refuses an unattributed caller', async () => {
    await expect(
      runWithCallerScope({ kind: 'unattributed' }, () =>
        createCommands().browserEval({ expression: '1' })
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('leaves local callers to fail on the bridge, not the bound', async () => {
    await expect(createCommands().browserEval({ expression: '1' })).rejects.toThrow(
      /must not reach the browser bridge|must not reach browser target resolution/
    )
  })
})
