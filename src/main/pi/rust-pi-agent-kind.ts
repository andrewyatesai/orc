import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shared/command-token-scanner'
import type { PiAgentKind } from '../../shared/pi-agent-kind'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { requireRustGitBinding } from '../daemon/rust-git-addon'

/** Which Pi-compatible agent a launch command starts ('omp' for OMP, else
 *  'pi') — the Rust orca-text detector via napi. The relay runs the same core
 *  via wasm; the shared TS regex was deleted. */
export function detectPiAgentKindFromCommand(command: string | undefined): PiAgentKind {
  return requireRustGitBinding().detectPiAgentKindFromCommand(command) as PiAgentKind
}

const PI_LAUNCH_BINARY = resolveLaunchBinary(TUI_AGENT_CONFIG.pi.launchCmd)

/**
 * The Pi-compatible kind a command EXPLICITLY launches, or null for bare shells
 * and other agents. Callers that must not materialize an agent home for a
 * terminal that never launches one need this null; `detectPiAgentKindFromCommand`
 * collapses it to the 'pi' default.
 */
export function detectExplicitPiAgentKindFromCommand(
  command: string | undefined
): PiAgentKind | null {
  const binary = resolveLaunchBinary(command ?? '')
  if (!binary) {
    return null
  }
  // Why: classify the isolated binary through the Rust core so the OMP rule stays
  // single-sourced there and an `omp` mentioned in argv cannot match.
  if (detectPiAgentKindFromCommand(binary) === 'omp') {
    return 'omp'
  }
  return binary === PI_LAUNCH_BINARY ? 'pi' : null
}

// Why: the launched binary is the first token's basename; Windows/shim suffixes are not part of the name.
function resolveLaunchBinary(command: string): string {
  return getCommandTokenPathBasename(getFirstCommandToken(command))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
}
