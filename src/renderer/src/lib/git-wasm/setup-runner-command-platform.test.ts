// Re-pointed from src/shared/setup-runner-command.test.ts: the resolver now lives
// in Rust (orca_core::setup_runner_command), so these cases pin the wasm-backed
// shim — including the pre-ready value, which decides which SHELL executes a
// worktree's setup runner.
import { describe, expect, it, vi } from 'vitest'
import './init-git-wasm-for-test'
import { getSetupRunnerCommandPlatformForPath } from './setup-runner-command-platform'

const WSL_UNC_RUNNER = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\orca\\setup-runner.sh'

describe('getSetupRunnerCommandPlatformForPath (orca-git wasm)', () => {
  it('prefers POSIX for absolute POSIX runner paths even from Windows clients', () => {
    expect(
      getSetupRunnerCommandPlatformForPath('/remote/repo/.git/orca/setup-runner.sh', 'windows')
    ).toBe('posix')
  })

  it('prefers Windows for native Windows runner paths even from POSIX clients', () => {
    expect(
      getSetupRunnerCommandPlatformForPath('C:\\repo\\.git\\orca\\setup-runner.cmd', 'posix')
    ).toBe('windows')
  })

  it('keeps WSL UNC paths on the Windows resolver so they can be converted', () => {
    expect(getSetupRunnerCommandPlatformForPath(WSL_UNC_RUNNER, 'posix')).toBe('windows')
  })

  it('keeps forward-slash UNC paths on the Windows resolver', () => {
    expect(
      getSetupRunnerCommandPlatformForPath(
        '//wsl.localhost/Ubuntu/home/jin/repo/.git/orca/setup-runner.sh',
        'posix'
      )
    ).toBe('windows')
    expect(
      getSetupRunnerCommandPlatformForPath(
        '//server/share/repo/.git/orca/setup-runner.cmd',
        'posix'
      )
    ).toBe('windows')
  })

  it('falls back to the caller platform for relative/ambiguous runner paths', () => {
    expect(getSetupRunnerCommandPlatformForPath('orca/setup-runner.sh', 'windows')).toBe('windows')
    expect(getSetupRunnerCommandPlatformForPath('./scripts/setup-runner.sh', 'posix')).toBe('posix')
  })

  it('answers a lone-surrogate path the codec cannot encode instead of throwing', () => {
    // A Windows worktree path is UTF-16 and may carry an unpaired surrogate; the
    // encode rejection must degrade to the twin's answer, not abort worktree create.
    expect(getSetupRunnerCommandPlatformForPath('C:\\repo\\\ud800\\setup.cmd', 'posix')).toBe(
      'windows'
    )
    expect(getSetupRunnerCommandPlatformForPath('/home/\ud800/setup.sh', 'windows')).toBe('posix')
  })
})

describe('getSetupRunnerCommandPlatformForPath before the core is ready', () => {
  it('returns the same platform the deleted TS returned, not a sentinel', async () => {
    // A fresh registry re-arms git-wasm-availability at `pending`; that is the same
    // state a terminally `unavailable` core leaves callers in. Both union members
    // are real answers, so a sentinel here would be executed as one.
    vi.resetModules()
    const { getSetupRunnerCommandPlatformForPath: preReady } =
      await import('./setup-runner-command-platform')

    expect(preReady('/remote/repo/.git/orca/setup-runner.sh', 'windows')).toBe('posix')
    expect(preReady('C:\\repo\\.git\\orca\\setup-runner.cmd', 'posix')).toBe('windows')
    expect(preReady(WSL_UNC_RUNNER, 'posix')).toBe('windows')
    expect(preReady('//server/share/repo/.git/orca/setup-runner.cmd', 'posix')).toBe('windows')
    expect(preReady('orca/setup-runner.sh', 'windows')).toBe('windows')
    expect(preReady('./scripts/setup-runner.sh', 'posix')).toBe('posix')
  })
})
