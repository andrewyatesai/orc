// Windows evidence-state half of the agent foreground-process suite: when a scan is
// authoritative — PowerShell/WMIC enumeration fallback and exact ConPTY membership.
// Name-resolution cases live in windows-agent-foreground-process.test.ts.
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

function windowsProcessJsonRows(
  rows: {
    CommandLine: string | null
    Name: string
    ParentProcessId: number
    ProcessId: number
    ExecutablePath?: string | null
  }[] = [
    {
      CommandLine: 'powershell.exe',
      Name: 'powershell.exe',
      ParentProcessId: 99,
      ProcessId: 100
    },
    {
      CommandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
      Name: 'node.exe',
      ParentProcessId: 100,
      ProcessId: 101
    }
  ]
): string {
  return JSON.stringify(
    rows.map((row) => ({
      ExecutablePath: row.ExecutablePath ?? null,
      ...row
    }))
  )
}

function windowsProcessValueRows(): string {
  return [
    'CommandLine=powershell.exe',
    'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'Name=powershell.exe',
    'ParentProcessId=99',
    'ProcessId=100',
    '',
    'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
    'ExecutablePath=C:\\Program Files\\nodejs\\node.exe',
    'Name=node.exe',
    'ParentProcessId=100',
    'ProcessId=101',
    ''
  ].join('\r\n')
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

  it('falls back to WMIC when Windows PowerShell process enumeration fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (cmd === 'powershell.exe') {
        callback(new Error('powershell unavailable'), { stdout: '', stderr: '' })
        return
      }
      callback(null, { stdout: windowsProcessValueRows(), stderr: '' })
    })

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'wmic',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('falls back to WMIC when Windows PowerShell returns no process rows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (cmd === 'powershell.exe') {
        callback(null, { stdout: '   \r\n', stderr: '' })
        return
      }
      callback(null, { stdout: windowsProcessValueRows(), stderr: '' })
    })

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'wmic',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('distinguishes unavailable Windows enumeration from a confirmed shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(new Error('enumeration unavailable'), { stdout: '', stderr: '' })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it.each([
    ['blank', '   \r\n'],
    ['unparseable', 'wmic returned no structured process values']
  ])('treats successful but %s WMIC output as unavailable', async (_label, wmicOutput) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (cmd === 'powershell.exe') {
        callback(new Error('powershell unavailable'), { stdout: '', stderr: '' })
        return
      }
      callback(null, { stdout: wmicOutput, stderr: '' })
    })

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('treats an observed Windows shell with no children as authoritative', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'powershell.exe',
              Name: 'powershell.exe',
              ParentProcessId: 99,
              ProcessId: 100
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('does not restore a recognized fallback that disappeared before confirmation', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'droid', {
        fresh: true,
        forceProcessScan: true
      })
    ).resolves.toEqual({ available: true, processName: null })
  })

  it('treats a Windows snapshot missing the requested shell as unavailable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'unrelated.exe',
              Name: 'unrelated.exe',
              ParentProcessId: 99,
              ProcessId: 200
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('filters detached agents before resolving an otherwise ambiguous ConPTY tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        },
        {
          CommandLine: 'droid',
          Name: 'droid.exe',
          ParentProcessId: 100,
          ProcessId: 101
        },
        {
          CommandLine: 'agy',
          Name: 'agy.exe',
          ParentProcessId: 100,
          ProcessId: 102
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds: async () => new Set([100, 101])
      })
    ).resolves.toEqual({ available: true, processName: 'droid' })
  })

  it('authorizes a fresh Windows agent only when it still belongs to the ConPTY', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        },
        {
          CommandLine: 'droid',
          Name: 'droid.exe',
          ParentProcessId: 100,
          ProcessId: 101
        }
      ])
    )
    const readWindowsConptyProcessIds = vi.fn(async () => new Set([100, 101, 999]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'droid' })
    expect(readWindowsConptyProcessIds).toHaveBeenCalledTimes(1)
  })

  it('excludes a detached Windows Droid descendant from byte authority', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        },
        {
          CommandLine: 'droid',
          Name: 'droid.exe',
          ParentProcessId: 100,
          ProcessId: 101
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds: async () => new Set([100, 999])
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('does not fork the ConPTY membership helper when no Windows agent is inferred', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        }
      ])
    )
    const readWindowsConptyProcessIds = vi.fn(async () => new Set([100, 999]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
    expect(readWindowsConptyProcessIds).not.toHaveBeenCalled()
  })
})
