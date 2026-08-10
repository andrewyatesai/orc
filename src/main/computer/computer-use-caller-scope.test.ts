import { describe, expect, it, vi } from 'vitest'
import { CallerScopeDeniedError, runWithCallerScope } from '../runtime/runtime-caller-scope'
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  callComputerSidecarListWindows,
  callComputerSidecarSnapshot
} from './sidecar-client'

// Why: the refusal must land before anything forks the sidecar — a remote pane
// driving the laptop desktop is the failure, not a slow one.
vi.mock('node:child_process', () => ({
  fork: vi.fn(() => {
    throw new Error('the computer sidecar must never be forked for a remote caller')
  })
}))

const REMOTE = { kind: 'ssh', connectionId: 'ssh_target_a' } as const

describe('computer-use is refused for remote callers', () => {
  it('refuses click/type-text/press-key from an SSH pane', async () => {
    for (const action of ['click', 'typeText', 'pressKey', 'hotkey', 'pasteText'] as const) {
      await expect(
        runWithCallerScope(REMOTE, () => callComputerSidecarAction(action, {}))
      ).rejects.toThrow(CallerScopeDeniedError)
    }
  })

  it('refuses the read side too — window lists and snapshots are the laptop screen', async () => {
    await expect(runWithCallerScope(REMOTE, () => callComputerSidecarSnapshot({}))).rejects.toThrow(
      /no host selector to bound/
    )
    await expect(
      runWithCallerScope(REMOTE, () => callComputerSidecarListWindows({}))
    ).rejects.toThrow(CallerScopeDeniedError)
    await expect(
      runWithCallerScope(REMOTE, () => callComputerSidecarCapabilities())
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('refuses an unattributed caller as well', async () => {
    await expect(
      runWithCallerScope({ kind: 'unattributed' }, () => callComputerSidecarAction('click', {}))
    ).rejects.toThrow(/could not attribute/)
  })

  it('names computer-use and the action in the refusal', async () => {
    await expect(
      runWithCallerScope(REMOTE, () => callComputerSidecarAction('click', {}))
    ).rejects.toThrow(/computer-use \(click\)/)
  })
})
