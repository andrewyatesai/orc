import { describe, expect, it } from 'vitest'
import { buildWslBridgeScript, buildWslLauncher, getWslBridgeMarker } from './wsl-cli-scripts'

describe('buildWslBridgeScript', () => {
  const script = buildWslBridgeScript()

  it('dedupes case-colliding env names before invoking the launcher (#9498)', () => {
    expect(script).toContain('Repair-OrcaDuplicateEnvNames')
    expect(script).toContain('GetEnvironmentStringsW')
    expect(script).toContain('FreeEnvironmentStringsW')
    // Why: the dedupe must run before the launcher spawn or .NET children still crash.
    expect(script.indexOf('Repair-OrcaDuplicateEnvNames')).toBeLessThan(
      script.indexOf('[System.Diagnostics.Process]::Start($StartInfo)')
    )
  })

  it('keeps the managed marker and launcher contract intact', () => {
    expect(script.startsWith(getWslBridgeMarker())).toBe(true)
    expect(script).toContain('$StartInfo.FileName = $OrcaLauncher')
    expect(script).toContain('exit $exitCode')
    // Why: a stray TS template interpolation would serialize as 'undefined' in the script.
    expect(script).not.toContain('undefined')
  })

  it('forwards native argv losslessly instead of PowerShell splatting (#12582)', () => {
    // Why: PS 5.1 @splat strips quotes/backslashes; ProcessStartInfo takes a
    // pre-escaped native command line so quoted --deps and paths survive.
    expect(script).toContain('function ConvertTo-NativeCommandLineArgument')
    expect(script).toContain('$StartInfo.UseShellExecute = $false')
    expect(script).toContain('[System.Diagnostics.Process]::Start($StartInfo)')
    expect(script).toContain('$Process.WaitForExit()')
    expect(script).toContain('$exitCode = $Process.ExitCode')
    // Why: the Windows argv rule doubles backslashes that precede a quote.
    expect(script).toContain("[void]$Quoted.Append([char]'\\', $BackslashCount * 2 + 1)")
    expect(script).not.toContain('& $OrcaLauncher @ForwardArgs')
  })

  it('stays embeddable in the installer bash heredoc', () => {
    // Why: the installer writes the bridge via <<'ORCA_WSL_BRIDGE'; a line equal
    // to the terminator would truncate the script.
    expect(script.split('\n').some((line) => line.trim() === 'ORCA_WSL_BRIDGE')).toBe(false)
    // Why: PowerShell here-string terminators must sit at line starts to parse.
    expect(script).toContain("$definition = @'\n")
    expect(/^'@$/m.test(script)).toBe(true)
  })
})

describe('buildWslLauncher', () => {
  it('pins Windows PowerShell for the bridge so the Framework env-dup detector applies', () => {
    const launcher = buildWslLauncher('C:\\Users\\alice\\AppData\\Local\\Orca\\orca.cmd')
    expect(launcher).toContain('powershell.exe')
    expect(launcher).toContain('-File "$ORCA_BRIDGE_PS1_WIN"')
  })
})
