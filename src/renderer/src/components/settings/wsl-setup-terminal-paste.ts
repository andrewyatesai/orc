import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'

/**
 * Adapts a copied skill command for Orca's inline setup-terminal auto-paste.
 * A WSL worktree forces the created tab onto wsl.exe (a bash PTY) even when the
 * requested shell was powershell.exe, so the host `& { wsl.exe ... }` wrapper
 * must become its bash-native login-shell script before it is pasted — a leading
 * `&` is a bash syntax error (#13305). Clipboard copy keeps the host wrapper for
 * manual use outside Orca.
 */
export function buildSkillSetupTerminalCommand(
  copiedCommand: string,
  effectiveShell: string | undefined
): string {
  // Why: the created tab's resolved shell is authoritative once the project
  // runtime replaces the requested shell with wsl.exe.
  if (!isWslShellName(effectiveShell)) {
    return copiedCommand
  }
  return decodeWslSetupTerminalCommand(copiedCommand) ?? copiedCommand
}

function decodeWslSetupTerminalCommand(command: string): string | null {
  if (
    !command.startsWith("& { $PSNativeCommandArgumentPassing = 'Legacy'; wsl.exe") ||
    !command.includes(' } # Runs: ')
  ) {
    return null
  }

  const encoded = /-- sh -c 'eval \\"`printf %s ([A-Za-z0-9+/=]+) \| base64 -d`\\"'/.exec(
    command
  )?.[1]
  if (!encoded) {
    return null
  }

  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
