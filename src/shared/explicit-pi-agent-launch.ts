import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'
import type { PiAgentKind } from './pi-agent-kind'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

// First command token's binary name, lower-cased with a trailing platform
// extension stripped. Mirrors the fuzzy Rust detector's launch-binary handling
// (getFirstCommandToken/getCommandTokenPathBasename), but only the exact binary
// name is compared here — no substring/boundary matching.
function getLaunchBinary(command: string): string {
  return getCommandTokenPathBasename(getFirstCommandToken(command))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
}

const PI_LAUNCH_BINARY = getLaunchBinary(TUI_AGENT_CONFIG.pi.launchCmd)
const OMP_LAUNCH_BINARY = getLaunchBinary(TUI_AGENT_CONFIG.omp.launchCmd)

/**
 * The Pi-compatible agent a command *explicitly* launches, or null for bare
 * shells and other agents.
 *
 * Unlike `detectPiAgentKindFromCommand` (the Rust orca-text detector, which
 * defaults the no-launch case to 'pi'), an unrecognized or empty command
 * returns null. That lets callers skip materializing an unused default agent
 * home for a bare shell instead of recreating deleted `~/.pi`/`~/.omp` dirs
 * on every terminal open (#10196).
 */
export function detectExplicitPiAgentKindFromCommand(
  command: string | undefined
): PiAgentKind | null {
  const binary = getLaunchBinary(command ?? '')
  if (binary === OMP_LAUNCH_BINARY) {
    return 'omp'
  }
  return binary === PI_LAUNCH_BINARY ? 'pi' : null
}
