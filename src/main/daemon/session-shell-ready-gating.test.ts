import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { ShellReadyState } from './types'
import type { TuiAgent } from '../../shared/types'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Stub the subprocess — Session talks to it via an interface, not child_process directly.
function createMockSubprocess() {
  const written: string[] = []
  const signals: string[] = []
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let killed = false
  let clearCalls = 0
  let pid = 12345
  let pauseCalls = 0
  let resumeCalls = 0

  return {
    written,
    signals,
    get killed() {
      return killed
    },
    get pid() {
      return pid
    },
    get pauseCalls() {
      return pauseCalls
    },
    get resumeCalls() {
      return resumeCalls
    },
    foregroundProcess: null as string | null,
    getForegroundProcess(): string | null {
      return this.foregroundProcess
    },
    write(data: string) {
      written.push(data)
    },
    resize(_cols: number, _rows: number) {},
    pause() {
      pauseCalls++
    },
    resume() {
      resumeCalls++
    },
    get clearCalls() {
      return clearCalls
    },
    clear() {
      clearCalls++
    },
    kill() {
      killed = true
      // Simulate async exit
      setTimeout(() => onExit?.(0), 5)
    },
    forceKill() {
      killed = true
    },
    signal(sig: string) {
      signals.push(sig)
    },
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(cb: (code: number) => void) {
      onExit = cb
    },
    dispose() {},
    // Helpers for tests to simulate subprocess events
    simulateData(data: string) {
      onData?.(data)
    },
    simulateExit(code: number) {
      onExit?.(code)
    }
  }
}

type MockSubprocess = ReturnType<typeof createMockSubprocess>

describe('Session', () => {
  let session: Session
  let subprocess: MockSubprocess

  beforeEach(() => {
    vi.useFakeTimers()
    subprocess = createMockSubprocess()
    killWithDescendantSweepMock.mockReset()
  })

  afterEach(() => {
    session?.dispose()
    vi.useRealTimers()
  })

  function createSession(opts?: {
    shellReadySupported?: boolean
    shellReadyTimeoutMs?: number
    cols?: number
    rows?: number
    launchAgent?: TuiAgent
    startupIngress?: {
      colors: { foreground: string; background: string }
      deadlineMs: number
    }
    ownerBackend?: 'posix-pty' | 'windows-conpty' | 'windows-wsl'
    wslDistro?: string
  }): Session {
    session = new Session({
      sessionId: 'test-session',
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
      ...(opts?.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      wslDistro: opts?.wslDistro,
      subprocess,
      ...(opts?.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
      shellReadySupported: opts?.shellReadySupported ?? false,
      ...(opts?.startupIngress ? { startupIngress: opts.startupIngress } : {}),
      ...(opts?.shellReadyTimeoutMs !== undefined
        ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
        : {})
    })
    return session
  }

  describe('shell readiness gating', () => {
    // Why: regression guard for "claude claude" double-echo. The marker fires
    // from precmd before readline switches the PTY into raw mode; flushing
    // then lets the kernel re-echo the command under the prompt. Detailed
    // timing behavior is covered by post-ready-flush-gate.test.ts.
    // Also checks writes that arrive during the gate window keep their order
    // — the gate continues to queue even though shellState is already 'ready'.
    it('defers flush past the shell-ready marker and preserves write order', () => {
      createSession({ shellReadySupported: true })
      expect(session.shellState).toBe('pending')

      session.write('first\n')
      subprocess.simulateData('\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      session.write('second\n')
      expect(subprocess.written).toEqual([])

      subprocess.simulateData('\r\nuser@host $ ')
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual(['first\n', 'second\n'])
    })

    it('uses the short settle path when marker and prompt bytes arrive together', () => {
      createSession({ shellReadySupported: true })
      session.write('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready\x07\r\nuser@host $ ')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      vi.advanceTimersByTime(29)
      expect(subprocess.written).toEqual([])

      vi.advanceTimersByTime(1)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('does not treat bytes before the marker as post-marker prompt output', () => {
      createSession({ shellReadySupported: true })
      session.write('codex\n')

      subprocess.simulateData('last login\r\n\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual([])

      subprocess.simulateData('\r\nuser@host $ ')
      vi.advanceTimersByTime(30)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('strips shell-ready marker bytes before client and pending-output fan-out', () => {
      createSession({ shellReadySupported: true })
      const received: string[] = []
      session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      subprocess.simulateData('hello \x1b]777;orca-shell-ready\x07% ')

      expect(received).toEqual(['hello % '])
      expect(session.takePendingOutput(false)?.records).toEqual([
        { kind: 'output', data: 'hello % ' }
      ])
      expect(session.getSnapshot()?.snapshotAnsi).toContain('hello % ')
      expect(session.getSnapshot()?.snapshotAnsi).not.toContain('orca-shell-ready')
    })

    it('publishes an absolute output sequence with live snapshots', () => {
      createSession()
      subprocess.simulateData('first')
      subprocess.simulateData('🟢second')

      expect(session.getSnapshot()?.outputSequence).toBe('first🟢second'.length)
      expect(session.takePendingOutput(true)?.snapshot?.outputSequence).toBe('first🟢second'.length)
    })

    it('releases held marker-prefix bytes before flushing queued input on timeout', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      const received: string[] = []
      session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      session.write('codex\n')
      vi.advanceTimersByTime(100)

      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(received).toEqual(['\x1b]777;orca-shell-ready'])
      expect(session.takePendingOutput(false)?.records).toEqual([
        { kind: 'output', data: '\x1b]777;orca-shell-ready' }
      ])
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('releases held marker-prefix bytes when the subprocess exits before readiness', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      const received: string[] = []
      session.attachClient({
        onData: (data) => received.push(data),
        onExit: () => {}
      })

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      subprocess.simulateExit(0)

      expect(received).toEqual(['\x1b]777;orca-shell-ready'])
      expect(session.takePendingOutput(false)?.records).toEqual([
        { kind: 'output', data: '\x1b]777;orca-shell-ready' }
      ])
    })

    it('keeps held marker-prefix bytes during live take-with-snapshot', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })
      session.write('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      const taken = session.takePendingOutput(true)
      subprocess.simulateData('\x07\r\nuser@host $ ')
      vi.advanceTimersByTime(30)

      expect(taken?.records).toEqual([])
      expect(taken?.snapshot).toBeTruthy()
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('releases held marker-prefix bytes before final take-with-snapshot', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 100 })

      subprocess.simulateData('\x1b]777;orca-shell-ready')
      const taken = session.takePendingOutput(true, { teardownSnapshot: true })

      expect(taken?.records).toEqual([{ kind: 'output', data: '\x1b]777;orca-shell-ready' }])
      expect(taken?.snapshot).toBeTruthy()
    })

    it('cancels the post-ready flush gate when force-disposing the subprocess', async () => {
      createSession({ shellReadySupported: true })
      session.write('codex\n')

      subprocess.simulateData('\x1b]777;orca-shell-ready\x07')
      expect(session.shellState).toBe('ready' satisfies ShellReadyState)
      const dispose = session.forceKillAndDisposeSubprocess()
      subprocess.simulateExit(137)
      await dispose
      vi.advanceTimersByTime(500)

      expect(subprocess.written).toEqual([])
    })

    it('transitions to timed_out after 15 seconds', () => {
      createSession({ shellReadySupported: true })
      session.write('waiting input')

      vi.advanceTimersByTime(15_000)

      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['waiting input'])
    })

    it('honors a shorter shell-ready timeout for Codex startup sessions', () => {
      createSession({ shellReadySupported: true, shellReadyTimeoutMs: 300 })
      session.write('codex\n')

      vi.advanceTimersByTime(299)
      expect(subprocess.written).toEqual([])

      vi.advanceTimersByTime(1)
      expect(session.shellState).toBe('timed_out' satisfies ShellReadyState)
      expect(subprocess.written).toEqual(['codex\n'])
    })

    it('detects marker split across data chunks', () => {
      createSession({ shellReadySupported: true })

      subprocess.simulateData('\x1b]777;orca-sh')
      expect(session.shellState).toBe('pending')

      subprocess.simulateData('ell-ready\x07')
      expect(session.shellState).toBe('ready')
    })
  })
})
