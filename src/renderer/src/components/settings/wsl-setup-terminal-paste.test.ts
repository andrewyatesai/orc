import { describe, expect, it } from 'vitest'
import { buildWslLoginShellCommand } from '../../../../shared/wsl-login-shell-command'
import { buildSkillCommandForRuntime } from './CliSkillRuntimeSetup'
import { buildSkillSetupTerminalCommand } from './wsl-setup-terminal-paste'

describe('buildSkillSetupTerminalCommand', () => {
  it('rewrites a WSL host wrapper to bash when the resolved tab shell is wsl.exe', () => {
    const skillCommand = 'npx skills add orchestration --global'
    const wslWrapper = buildSkillCommandForRuntime(
      skillCommand,
      { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' },
      'win32'
    )
    // Precondition: the copied command really is the leading-`&` PowerShell wrapper.
    expect(wslWrapper.startsWith('& {')).toBe(true)

    const pasted = buildSkillSetupTerminalCommand(wslWrapper, 'wsl.exe')
    expect(pasted.startsWith('&')).toBe(false)
    expect(pasted).toBe(buildWslLoginShellCommand(skillCommand))
    expect(pasted).toContain('npx skills add orchestration --global')
  })

  it('keeps the host wrapper when the tab stays on powershell.exe', () => {
    const wslWrapper = buildSkillCommandForRuntime(
      'npx skills add orchestration --global',
      { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' },
      'win32'
    )

    expect(buildSkillSetupTerminalCommand(wslWrapper, 'powershell.exe')).toBe(wslWrapper)
  })

  it('preserves a multibyte script byte-for-byte across the decode', () => {
    const skillCommand = "printf 'héllo\n# Runs: unchanged'"
    const wslWrapper = buildSkillCommandForRuntime(skillCommand, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    })

    expect(buildSkillSetupTerminalCommand(wslWrapper, 'wsl.exe')).toBe(
      buildWslLoginShellCommand(skillCommand)
    )
  })

  it('leaves a bare POSIX command untouched for a bash tab', () => {
    expect(buildSkillSetupTerminalCommand('npx skills add orchestration --global', 'wsl.exe')).toBe(
      'npx skills add orchestration --global'
    )
  })
})
