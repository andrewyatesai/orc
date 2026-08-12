// Why: on native Windows the generated skill setup command runs `npx skills
// add|update`, but a machine without Node on PATH fails with a bare "npx is not
// recognized" and no next step. Wrap it in a cmd.exe preflight that guides the
// user to install Node.js LTS when npx is missing (#10438).

const WINDOWS_MISSING_NPX_GUIDANCE =
  'echo ERROR: npx was not found. Install Node.js LTS from https://nodejs.org/ to get npx. & echo Then close this terminal and start skill setup again - a new terminal picks up the updated PATH. & exit /b 1'

/**
 * Wraps a native-Windows `npx skills add|update` command in a cmd.exe preflight
 * that checks for npx on PATH before running it. Non-Windows platforms, focused
 * remote runtime environments (the terminal spawns there), and non-skill
 * commands pass through untouched.
 */
export function wrapWindowsSkillCommandWithNpxPrerequisite(
  command: string,
  currentPlatform: NodeJS.Platform,
  remoteRuntimeEnvironmentFocused: boolean
): string {
  const trimmedCommand = command.trim()
  if (
    currentPlatform !== 'win32' ||
    remoteRuntimeEnvironmentFocused ||
    !/^npx\s+skills\s+(?:add|update)\b/i.test(trimmedCommand)
  ) {
    return command
  }

  // Why: cmd.exe is one shell-neutral boundary for PowerShell and Command
  // Prompt, and it resolves the bare name through PATHEXT for both the preflight
  // and the executed command, so shims such as npx.exe (Volta) still count.
  return `cmd.exe /d /s /c "where.exe npx >nul 2>nul & if errorlevel 1 (${WINDOWS_MISSING_NPX_GUIDANCE}) else (${trimmedCommand})"`
}
