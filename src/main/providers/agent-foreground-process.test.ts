// POSIX half of the agent foreground-process suite (ps stat flags, tmux client hop).
// Windows cases live in windows-agent-foreground-process.test.ts and
// windows-agent-foreground-availability.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resetTmuxActivePaneCacheForTests } from '../../shared/tmux-active-pane'
import {
  resolveAgentForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-foreground-process'
import { resetWindowsProcessRowsSnapshotForTests } from './windows-foreground-process-rows'

// Why: the module wraps execFile with promisify, so the mock must honor the
// Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

describe('resolveAgentForegroundProcess', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    resetTmuxActivePaneCacheForTests()
    // Why: the Windows rows reader caches across calls (500ms TTL), so each
    // case's execFile mock must not be answered by the previous case's rows.
    resetWindowsProcessRowsSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('does not report a suspended agent when a non-agent holds the foreground', async () => {
    // shell pid 100. vim (pid 102) holds the terminal foreground ('+'); a
    // suspended codex (pid 101, stat 'T', no '+') is a backgrounded descendant.
    mockPs(
      [
        '101 100 T    node /userhome/dev/.nvm/versions/node/bin/codex',
        '102 100 S+   vim notes.txt'
      ].join('\n')
    )

    await expect(resolveAgentForegroundProcess(100, 'vim')).resolves.toBe('vim')
  })

  it('still reports a foreground agent', async () => {
    mockPs(['101 100 S+   node /userhome/dev/.nvm/versions/node/bin/codex'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })

  // Why: OMP embeds Pi, but the outer process is the user-visible identity (#6364).
  it('reports the outer omp wrapper, not the wrapped pi child', async () => {
    mockPs(['101 100 S+   omp', '102 101 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'omp')).resolves.toBe('omp')
  })

  it('reports omp even when the wrapped pi child holds the foreground alone', async () => {
    // Why: across command boundaries only the deeper `pi` carries `+`; the
    // wrapper identity must stay omp regardless of which frame we sampled.
    mockPs(['101 100 S    omp', '102 101 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'omp')).resolves.toBe('omp')
  })

  it('reports bare pi when no omp wrapper is present', async () => {
    mockPs(['101 100 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'pi')).resolves.toBe('pi')
  })

  it('treats a fresh POSIX snapshot missing the PTY root as unavailable', async () => {
    mockPs('101 999 S+ node /userhome/dev/.nvm/versions/node/bin/codex')

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
  })

  it('treats failed POSIX scans as unavailable', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(new Error('ps unavailable'), { stdout: '', stderr: '' })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
    // Why: a failed non-fresh scan is also non-authoritative (#6364); callers
    // must retain their last recognized agent rather than trust the shell.
    await expect(resolveAgentForegroundProcessWithAvailability(100, 'zsh')).resolves.toEqual({
      available: false,
      processName: 'zsh'
    })
    await expect(resolveAgentForegroundProcess(100, 'zsh')).resolves.toBe('zsh')
  })

  it('detects an agent hosted inside a user tmux via the client hop', async () => {
    // Pane shell (100) -> tmux client (200). The real claude (401) lives under
    // the reparented tmux server (300, ppid 1), unreachable from the shell.
    execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, r: { stdout: string; stderr: string }) => void
      if (cmd === 'tmux') {
        expect(args).toContain('list-clients')
        callback(null, { stdout: '200 400\n', stderr: '' })
        return
      }
      callback(null, {
        stdout: [
          '100 99  Ss   bash -i',
          '200 100 S+   tmux attach -t work',
          '300 1   Ss   tmux: server',
          '400 300 Ss   bash',
          '401 400 S+   claude'
        ].join('\n'),
        stderr: ''
      })
    })

    await expect(resolveAgentForegroundProcess(100, 'tmux')).resolves.toBe('claude')
  })

  it('falls back when the tmux client has no resolvable active pane', async () => {
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, r: { stdout: string; stderr: string }) => void
      if (cmd === 'tmux') {
        callback(null, { stdout: '999 400\n', stderr: '' }) // different client pid
        return
      }
      callback(null, {
        stdout: ['100 99  Ss   bash -i', '200 100 S+   tmux attach'].join('\n'),
        stderr: ''
      })
    })

    await expect(resolveAgentForegroundProcess(100, 'tmux')).resolves.toBe('tmux')
  })

  it('does not report Claude print-mode hook descendants as foreground agents', async () => {
    mockPs(
      [
        '100 99 Ss   bash -i',
        '101 100 S+   claude --print --model haiku Analyze this conversation and determine next work'
      ].join('\n')
    )

    await expect(resolveAgentForegroundProcess(100, 'bash')).resolves.toBe('bash')
  })

  it('does not report a stopped agent after the shell regains foreground', async () => {
    mockPs(
      ['100 99 Ss+  bash -i', '101 100 T    node /userhome/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'bash')).resolves.toBe('bash')
  })

  it('falls back to recognized descendants when no process in the PTY tree holds foreground', async () => {
    // No '+' marker at all (e.g. a detached/daemon descendant tree) — the
    // recognized agent may still be the best available signal.
    mockPs(
      ['100 99 Ss   bash -i', '101 100 S    node /userhome/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })
})
