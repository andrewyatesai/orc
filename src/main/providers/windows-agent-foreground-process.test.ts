// Windows half of the agent foreground-process resolution suite: which agent name
// the Windows process tree resolves to. Availability/ConPTY cases live in
// windows-agent-foreground-availability.test.ts; POSIX cases in agent-foreground-process.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resetTmuxActivePaneCacheForTests } from '../../shared/tmux-active-pane'
import { resolveAgentForegroundProcess } from './agent-foreground-process'
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

  it('reports the outer omp wrapper on Windows', async () => {
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
            },
            {
              CommandLine: 'omp.exe',
              Name: 'omp.exe',
              ParentProcessId: 100,
              ProcessId: 101
            },
            {
              CommandLine: 'pi.exe',
              Name: 'pi.exe',
              ParentProcessId: 101,
              ProcessId: 102
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'pi.exe')).resolves.toBe('omp')
  })

  it('keeps the Windows omp ancestor when context selects one of multiple pi descendants', async () => {
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
          CommandLine: 'omp.exe',
          Name: 'omp.exe',
          ParentProcessId: 100,
          ProcessId: 101
        },
        {
          CommandLine: 'pi.exe --cwd C:\\repo\\orca',
          Name: 'pi.exe',
          ParentProcessId: 101,
          ProcessId: 102
        },
        {
          CommandLine: 'pi.exe --cwd C:\\repo\\other',
          Name: 'pi.exe',
          ParentProcessId: 100,
          ProcessId: 103
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcess(100, 'pi.exe', { contextPaths: ['C:\\repo\\orca'] })
    ).resolves.toBe('omp')
  })

  it('recognizes Windows wrapper-launched agents from descendant command lines', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, { stdout: windowsProcessJsonRows(), stderr: '' })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('recognizes Windows shell-rooted agent launches from descendant command lines', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, { stdout: windowsProcessJsonRows(), stderr: '' })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('codex')
  })

  it('recognizes the native Windows Cursor launcher process tree', async () => {
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
          CommandLine: 'cmd.exe /c cursor-agent.cmd',
          Name: 'cmd.exe',
          ParentProcessId: 100,
          ProcessId: 101
        },
        {
          CommandLine:
            'powershell.exe -File C:\\Users\\dev\\AppData\\Local\\cursor-agent\\cursor-agent.ps1',
          Name: 'powershell.exe',
          ParentProcessId: 101,
          ProcessId: 102
        },
        {
          CommandLine:
            'node.exe C:\\Users\\dev\\AppData\\Local\\cursor-agent\\versions\\2026.07.09-a3815c0\\index.js',
          Name: 'node.exe',
          ParentProcessId: 102,
          ProcessId: 103
        },
        {
          CommandLine:
            'node.exe C:\\Users\\dev\\AppData\\Local\\cursor-agent\\versions\\2026.07.09-a3815c0\\index.js worker-server',
          Name: 'node.exe',
          ParentProcessId: 103,
          ProcessId: 104
        },
        {
          CommandLine: 'C:\\Users\\dev\\.grok\\bin\\agent.exe',
          Name: 'agent.exe',
          ParentProcessId: 100,
          ProcessId: 105
        }
      ])
    )

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('cursor-agent')
  })

  it('recognizes Windows Git Bash shell-rooted agent launches', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'C:\\Program Files\\Git\\bin\\bash.exe --login -i',
              Name: 'bash.exe',
              ParentProcessId: 99,
              ProcessId: 100
            },
            {
              CommandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
              Name: 'node.exe',
              ParentProcessId: 100,
              ProcessId: 101
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'bash.exe')).resolves.toBe('codex')
  })

  // Why: OMP runs shell->omp->pi on Windows too; the outer omp is the identity (#6364).
  it('reports the outer omp wrapper from a Windows shell-rooted omp->pi tree', async () => {
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
            },
            { CommandLine: 'omp', Name: 'omp.exe', ParentProcessId: 100, ProcessId: 101 },
            { CommandLine: 'pi', Name: 'pi.exe', ParentProcessId: 101, ProcessId: 102 }
          ]),
          stderr: ''
        })
      }
    )

    // Pre-fix the deepest recognized leaf (pi) was returned raw; the leaf must
    // now resolve through the same-group wrapper to the outer omp.
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('omp')
  })

  it('rescans a node-pty pi fallback to its Windows omp wrapper', async () => {
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
            },
            { CommandLine: 'omp', Name: 'omp.exe', ParentProcessId: 100, ProcessId: 101 },
            { CommandLine: 'pi', Name: 'pi.exe', ParentProcessId: 101, ProcessId: 102 }
          ]),
          stderr: ''
        })
      }
    )

    // Pre-fix a bare 'pi' fallback never triggered a scan (pi is not a shell or
    // node/python wrapper), so raw 'pi' was trusted; it must now rescan to omp.
    await expect(resolveAgentForegroundProcess(100, 'pi')).resolves.toBe('omp')
  })

  it('keeps multiline Windows command lines inside the parsed process row', async () => {
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
            },
            {
              CommandLine: [
                'node',
                'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
                '--prompt',
                '"line one\r\nName=gemini.exe\r\nProcessId=999"'
              ].join(' '),
              Name: 'node.exe',
              ParentProcessId: 100,
              ProcessId: 101
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('codex')
  })

  it('does not use unrelated Windows agent descendants for wrapper fallbacks', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\repo\\server.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=codex',
            'Name=codex.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('fails closed for ambiguous Windows shell-rooted agent descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.mjs',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('recognizes a Windows shell-rooted agent when only one candidate matches the worktree path', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'CreationDate=20260616110000.000000-000',
            'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js --cwd C:\\repo\\orca',
            'CreationDate=20260616110100.000000-000',
            'ExecutablePath=C:\\Program Files\\nodejs\\node.exe',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.mjs --cwd C:\\repo\\other',
            'CreationDate=20260616110200.000000-000',
            'ExecutablePath=C:\\Program Files\\nodejs\\node.exe',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('codex')
  })

  it('recognizes the deepest Windows shell-rooted agent when candidates share one lineage', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'CreationDate=20260616110000.000000-000',
            'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=codex --cwd C:\\repo\\orca',
            'CreationDate=20260616110100.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
            'Name=codex.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=gemini --cwd C:\\repo\\orca',
            'CreationDate=20260616110200.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd',
            'Name=gemini.exe',
            'ParentProcessId=101',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('gemini')
  })

  it('fails closed for sibling Windows agents that both match the same worktree path', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'CreationDate=20260616110000.000000-000',
            'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=codex --cwd C:\\repo\\orca',
            'CreationDate=20260616110100.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
            'Name=codex.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=gemini --cwd C:\\repo\\orca',
            'CreationDate=20260616110200.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd',
            'Name=gemini.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('powershell.exe')
  })

  it('fails closed when Windows has multiple matching wrapper descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\repo\\server.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('does not enrich Windows foregrounds that are not interpreter wrappers', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    await expect(resolveAgentForegroundProcess(100, 'vim.exe')).resolves.toBe('vim.exe')
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
