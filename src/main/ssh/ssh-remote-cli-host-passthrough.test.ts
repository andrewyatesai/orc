import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/host/app'
  }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import {
  HostCliUnavailableError,
  buildHostCliEnv,
  parseRemoteOrcaCliRequest,
  resolveHostCliCallerCwd,
  resolveHostCliEntryPath,
  resolveHostCliKillTimeoutMs,
  runHostOrcaCliPassthrough
} from './ssh-remote-cli-host-passthrough'
import { resolveOrchestrationAskClientTimeoutMs } from '../../shared/orchestration-ask-timeout'
import { remoteCliRequestTimeoutMs } from '../../relay/remote-cli-timeout'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn(), on: vi.fn() }
  child.kill = vi.fn()
  return child
}

const BASE_OPTIONS = {
  execPath: '/host/electron',
  cliEntryPath: '/host/app/out/cli/index.js',
  userDataPath: '/host/user-data',
  entryExists: () => true
}

describe('resolveHostCliEntryPath', () => {
  it('uses the in-repo entry for dev builds and the unpacked asar entry when packaged', () => {
    expect(
      resolveHostCliEntryPath({ isPackaged: false, resourcesPath: '/r', appPath: '/host/app' })
    ).toBe(join('/host/app', 'out', 'cli', 'index.js'))
    expect(
      resolveHostCliEntryPath({ isPackaged: true, resourcesPath: '/r', appPath: '/host/app' })
    ).toBe(join('/r', 'app.asar.unpacked', 'out', 'cli', 'index.js'))
  })
})

const ATTRIBUTED_PANE = {
  paneKey: 'pane-9',
  worktreeId: 'repo::/home/alice/wt',
  terminalHandle: 'term_remote',
  workspaceId: 'ws-1'
}

describe('buildHostCliEnv', () => {
  it('carries the relay-attributed pane into the host CLI subprocess', () => {
    const env = buildHostCliEnv({
      hostEnv: { PATH: '/host/bin', NODE_OPTIONS: '--inspect' },
      identity: ATTRIBUTED_PANE,
      userDataPath: '/host/user-data',
      remoteCwd: '/home/alice/wt/sub'
    })

    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_remote')
    expect(env.ORCA_WORKTREE_ID).toBe('repo::/home/alice/wt')
    expect(env.ORCA_PANE_KEY).toBe('pane-9')
    expect(env.ORCA_WORKSPACE_ID).toBe('ws-1')
    expect(env.PATH).toBe('/host/bin')
    expect(env.ORCA_USER_DATA_PATH).toBe('/host/user-data')
    expect(env.ORCA_CLI_CWD).toBe('/home/alice/wt/sub')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.ORCA_NODE_OPTIONS).toBe('--inspect')
  })

  it('clears the pane identity this app process inherited when nothing is attributed', () => {
    // Why: Orca launched from an Orca pane inherits that pane's vars. Leaving
    // them would hand an unattributable remote call the host pane's authority.
    const env = buildHostCliEnv({
      hostEnv: {
        PATH: '/host/bin',
        ORCA_PANE_KEY: 'host-launch-pane',
        ORCA_WORKTREE_ID: 'repo::/Users/alice/host-wt',
        ORCA_TERMINAL_HANDLE: 'term_host',
        ORCA_WORKSPACE_ID: 'ws-host'
      },
      identity: {},
      userDataPath: '/host/user-data',
      remoteCwd: '/home/alice/wt/sub'
    })

    expect(env.ORCA_PANE_KEY).toBeUndefined()
    expect(env.ORCA_WORKTREE_ID).toBeUndefined()
    expect(env.ORCA_TERMINAL_HANDLE).toBeUndefined()
    expect(env.ORCA_WORKSPACE_ID).toBeUndefined()
  })

  it('bounds ORCA_CLI_CWD by the attributed pane, not by what the caller sent', () => {
    const outsidePane = buildHostCliEnv({
      hostEnv: {},
      identity: ATTRIBUTED_PANE,
      userDataPath: '/host/user-data',
      remoteCwd: '/Users/alice/orca'
    })
    expect(outsidePane.ORCA_CLI_CWD).toBe('/home/alice/wt')

    const unattributed = buildHostCliEnv({
      hostEnv: {},
      identity: {},
      userDataPath: '/host/user-data',
      remoteCwd: '/Users/alice/orca'
    })
    expect(unattributed.ORCA_CLI_CWD).toBe('/')
  })

  it('replaces the inherited identity rather than merging with it', () => {
    const env = buildHostCliEnv({
      hostEnv: { ORCA_PANE_KEY: 'host-launch-pane', ORCA_WORKSPACE_ID: 'ws-host' },
      identity: { paneKey: 'pane-9' },
      userDataPath: '/host/user-data',
      remoteCwd: '/home/alice/wt'
    })

    expect(env.ORCA_PANE_KEY).toBe('pane-9')
    expect(env.ORCA_WORKSPACE_ID).toBeUndefined()
  })
})

describe('parseRemoteOrcaCliRequest', () => {
  it('takes pane identity from the relay attribution and drops the payload copy', () => {
    const request = parseRemoteOrcaCliRequest({
      argv: ['terminal', 'list', 42],
      cwd: '/home/alice/wt/src',
      env: {
        PATH: '/remote/bin',
        ORCA_PANE_KEY: 'pane-forged',
        ORCA_TERMINAL_HANDLE: 'term_forged',
        ORCA_WORKTREE_ID: 'repo::/home/alice/other',
        ORCA_WORKSPACE_ID: 'ws-forged',
        NOT_A_STRING: 7
      },
      identity: { paneKey: 'pane-9', terminalHandle: 'term_remote', bogus: 'ignored' },
      stdin: 'payload'
    })

    expect(request).toEqual({
      argv: ['terminal', 'list'],
      cwd: '/home/alice/wt/src',
      // Why: the legacy in-process fallback still reads pane context out of env,
      // so the attributed values must be what it finds there.
      env: { PATH: '/remote/bin', ORCA_PANE_KEY: 'pane-9', ORCA_TERMINAL_HANDLE: 'term_remote' },
      identity: { paneKey: 'pane-9', terminalHandle: 'term_remote' },
      stdin: 'payload'
    })
  })

  it('leaves no pane identity in env when the relay attributed none', () => {
    const request = parseRemoteOrcaCliRequest({
      argv: ['status'],
      env: { ORCA_PANE_KEY: 'pane-forged', ORCA_WORKTREE_ID: 'repo::/home/alice/other' }
    })

    expect(request.env).toEqual({})
    expect(request.identity).toEqual({})
    expect(request.cwd).toBe('/')
    expect(request.stdin).toBeUndefined()
  })
})

describe('resolveHostCliCallerCwd', () => {
  it('keeps a remote cwd inside the calling pane worktree', () => {
    expect(resolveHostCliCallerCwd('/home/alice/wt/src/deep', ATTRIBUTED_PANE)).toBe(
      '/home/alice/wt/src/deep'
    )
  })

  it('pins a cwd outside that worktree back to it', () => {
    // Why: `--worktree active` resolves this against every worktree the host
    // knows, remote and local alike, so an out-of-pane cwd could select a
    // checkout on the user's own machine.
    expect(resolveHostCliCallerCwd('/Users/alice/orca', ATTRIBUTED_PANE)).toBe('/home/alice/wt')
    expect(resolveHostCliCallerCwd('/home/alice/wt-evil', ATTRIBUTED_PANE)).toBe('/home/alice/wt')
    // Why: the containment check is textual and the CLI resolves what it gets,
    // so traversal must be collapsed before the decision, not after it.
    expect(resolveHostCliCallerCwd('/home/alice/wt/../other', ATTRIBUTED_PANE)).toBe(
      '/home/alice/wt'
    )
    expect(
      resolveHostCliCallerCwd('/home/alice/wt/../../../Users/alice/orca', ATTRIBUTED_PANE)
    ).toBe('/home/alice/wt')
  })

  it('collapses traversal that stays inside the pane worktree', () => {
    expect(resolveHostCliCallerCwd('/home/alice/wt/src/../lib', ATTRIBUTED_PANE)).toBe(
      '/home/alice/wt/lib'
    )
  })

  it('leaves an unattributed call no directory to select a worktree with', () => {
    expect(resolveHostCliCallerCwd('/Users/alice/orca', {})).toBe('/')
    expect(resolveHostCliCallerCwd('/Users/alice/orca', { paneKey: 'pane-9' })).toBe('/')
  })

  it('resolves a Windows remote pane against its own worktree', () => {
    const windowsPane = { worktreeId: 'repo::C:\\Users\\alice\\wt' }
    expect(resolveHostCliCallerCwd('C:\\Users\\alice\\wt\\src', windowsPane)).toBe(
      'C:\\Users\\alice\\wt\\src'
    )
    expect(resolveHostCliCallerCwd('C:\\Users\\alice\\other', windowsPane)).toBe(
      'C:\\Users\\alice\\wt'
    )
  })
})

describe('resolveHostCliKillTimeoutMs', () => {
  it('extends the kill timer past an explicit --timeout-ms budget', () => {
    expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', '1800000'])).toBe(
      1_920_000
    )
    expect(resolveHostCliKillTimeoutMs(['orchestration', 'check', '--timeout-ms=5000'])).toBe(
      600_000
    )
    expect(resolveHostCliKillTimeoutMs(['worktree', 'list'])).toBe(600_000)
  })

  it.each([
    [[], 720_000],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER)], 1_920_000],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER + 1)], 720_000],
    [['--timeout-ms', '9007199254740991.1'], 720_000],
    [['--timeout-ms', '1', '--timeout-ms=1800000'], 1_920_000],
    [['--timeout-ms=1800000', '--timeout-ms', '1'], 600_000],
    [['--timeout-ms', '1800000', '--timeout-ms'], 720_000],
    [['--timeout-ms=1800000', '--timeout-ms='], 720_000],
    [['--timeout-ms=1800000', '--timeout-ms', 'bad'], 720_000],
    [['--timeout-ms', 'bad', '--timeout-ms=1800000'], 1_920_000],
    [['--timeout-ms=bad', '--timeout-ms', '1800000'], 1_920_000]
  ])('bounds ask child timers with last-wins flags %#', (timeoutArgs, expected) => {
    expect(resolveHostCliKillTimeoutMs(['orchestration', '--json', 'ask', ...timeoutArgs])).toBe(
      expected
    )
  })

  it('does not apply the ask maximum to other commands', () => {
    expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', '1800001'])).toBe(
      1_920_001
    )
  })

  it.each(['+1000000', '1000000.0', '1e6'])(
    'extends non-ask child timers using CLI-compatible integer syntax %s',
    (raw) => {
      expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', raw])).toBe(1_120_000)
    }
  )

  it.each([
    'Infinity',
    '1.5',
    '-1',
    'bad',
    String(Number.MAX_SAFE_INTEGER),
    String(MAX_TIMER_DELAY_MS - 120_000 + 1)
  ])('falls back to the default kill timer when a non-ask --timeout-ms %s is unusable', (raw) => {
    expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', raw])).toBe(600_000)
  })

  it('keeps the largest non-ask kill timer that stays inside the timer range', () => {
    expect(
      resolveHostCliKillTimeoutMs([
        'terminal',
        'wait',
        '--timeout-ms',
        String(MAX_TIMER_DELAY_MS - 120_000)
      ])
    ).toBe(MAX_TIMER_DELAY_MS)
  })

  it.each<[string[], number | undefined]>([
    [[], undefined],
    [['--timeout-ms', '1'], 1],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER)], Number.MAX_SAFE_INTEGER],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER + 1)], undefined]
  ])('keeps inner, host, and relay ask deadlines ordered %#', (timeoutArgs, parsedTimeout) => {
    const argv = ['orchestration', 'ask', '--to', 'term_x', ...timeoutArgs]
    const innerTimeout = resolveOrchestrationAskClientTimeoutMs(parsedTimeout)
    const hostTimeout = resolveHostCliKillTimeoutMs(argv)
    const relayTimeout = remoteCliRequestTimeoutMs({ argv })

    expect(innerTimeout).toBeLessThan(hostTimeout)
    expect(hostTimeout).toBeLessThan(relayTimeout!)
  })
})

describe('runHostOrcaCliPassthrough', () => {
  it('spawns the bundled CLI entry with the remote argv and returns captured output', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      {
        argv: ['orchestration', 'task-create', '--spec', 'do the thing', '--json'],
        cwd: '/home/alice/wt',
        // A remote caller can put anything here; only `identity` is authority.
        env: { ORCA_TERMINAL_HANDLE: 'term_forged', ORCA_PANE_KEY: 'pane-forged' },
        identity: { terminalHandle: 'term_remote', worktreeId: 'repo::/home/alice/wt' }
      },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.stdout.emit('data', Buffer.from('{"ok":true}\n'))
    child.stderr.emit('data', Buffer.from('warn\n'))
    child.emit('close', 0)

    const result = await resultPromise
    expect(result).toEqual({ stdout: '{"ok":true}\n', stderr: 'warn\n', exitCode: 0 })

    expect(spawn).toHaveBeenCalledTimes(1)
    const [execPath, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv }
    ]
    expect(execPath).toBe('/host/electron')
    expect(args).toEqual([
      '/host/app/out/cli/index.js',
      'orchestration',
      'task-create',
      '--spec',
      'do the thing',
      '--json'
    ])
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.env.ORCA_CLI_CWD).toBe('/home/alice/wt')
    expect(options.env.ORCA_TERMINAL_HANDLE).toBe('term_remote')
    expect(options.env.ORCA_PANE_KEY).toBeUndefined()
    // Why: stdin must be closed even without a payload so CLI handlers that
    // stream stdin see EOF instead of hanging forever.
    expect(child.stdin.end).toHaveBeenCalledWith()
  })

  it('pipes a stdin payload to the CLI subprocess', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      {
        argv: ['linear', 'comment', 'add', 'ENG-1', '--body-file', '-'],
        cwd: '/home/alice/wt',
        env: {},
        stdin: 'comment body'
      },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.emit('close', 0)
    await resultPromise

    expect(child.stdin.end).toHaveBeenCalledWith('comment body')
  })

  it('propagates non-zero exit codes', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      { argv: ['worktree', 'show'], cwd: '/', env: {} },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.stderr.emit('data', Buffer.from('boom\n'))
    child.emit('close', 3)

    await expect(resultPromise).resolves.toEqual({ stdout: '', stderr: 'boom\n', exitCode: 3 })
  })

  it('throws HostCliUnavailableError when the CLI entry is missing', async () => {
    const spawn = vi.fn()
    await expect(
      runHostOrcaCliPassthrough(
        { argv: ['status'], cwd: '/', env: {} },
        { ...BASE_OPTIONS, entryExists: () => false, spawn: spawn as never }
      )
    ).rejects.toBeInstanceOf(HostCliUnavailableError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an invalid injected kill timeout before spawning', async () => {
    const spawn = vi.fn()
    await expect(
      runHostOrcaCliPassthrough(
        { argv: ['status'], cwd: '/', env: {} },
        { ...BASE_OPTIONS, spawn: spawn as never, killTimeoutMs: 2_147_483_648 }
      )
    ).rejects.toBeInstanceOf(RangeError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('throws HostCliUnavailableError when the subprocess fails to launch', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      { argv: ['status'], cwd: '/', env: {} },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.emit('error', new Error('spawn ENOENT'))

    await expect(resultPromise).rejects.toBeInstanceOf(HostCliUnavailableError)
  })

  it('kills the subprocess and reports an error when the kill timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const child = createFakeChild()
      const spawn = vi.fn(() => child)

      const resultPromise = runHostOrcaCliPassthrough(
        { argv: ['terminal', 'wait', '--for', 'exit'], cwd: '/', env: {} },
        { ...BASE_OPTIONS, spawn: spawn as never, killTimeoutMs: 1000 }
      )

      await vi.advanceTimersByTimeAsync(1001)
      const result = await resultPromise
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps runaway output instead of buffering it unbounded', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      { argv: ['terminal', 'read'], cwd: '/', env: {} },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    const chunk = Buffer.alloc(3 * 1024 * 1024, 97)
    for (let i = 0; i < 4; i += 1) {
      child.stdout.emit('data', chunk)
    }
    child.emit('close', 0)

    const result = await resultPromise
    expect(result.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024 + 64)
    expect(result.stdout).toContain('output truncated')
  })
})
