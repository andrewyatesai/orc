import path from 'node:path'
import { resolveCliCommands } from '../../shared/node-cli-command-resolution'

// Why: path.isAbsolute binds to the host OS at load, so a stubbed win32 platform needs the explicit
// win32 matcher for Windows install-dir detection (#5149).
function isPlatformAbsolute(candidate: string): boolean {
  return process.platform === 'win32'
    ? path.win32.isAbsolute(candidate)
    : path.isAbsolute(candidate)
}

// Why: local agent detection may run before shell-PATH hydration, but the
// fallback must stay bounded because it runs on the main process.
export function detectCommandsInInstallDirs(commands: readonly string[]): Set<string> {
  if (commands.length === 0) {
    return new Set()
  }
  try {
    const resolvedCommands = resolveCliCommands(commands)
    return new Set(
      commands.filter((command) => isPlatformAbsolute(resolvedCommands.get(command) ?? command))
    )
  } catch {
    return new Set()
  }
}
