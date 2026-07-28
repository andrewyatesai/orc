// Main-process terminal quick-command sanitizer, driven by the Rust orca-agents
// core via napi. `src/shared/terminal-quick-commands.ts` still exists for mobile
// (no napi there), so the main process must route through this seam rather than
// import it — otherwise two normalizers run over the same data in one process.
// The renderer drives the fuller helper set through the same op via wasm.
import { requireRustGitBinding } from './daemon/rust-git-addon'
import type { TerminalAgentQuickCommand, TerminalQuickCommand } from '../shared/types'

function terminalQuickCommandOp(operation: string, input: unknown): unknown {
  return JSON.parse(
    requireRustGitBinding().terminalQuickCommandOp(operation, JSON.stringify(input ?? null))
  )
}

export function normalizeTerminalQuickCommands(input: unknown): TerminalQuickCommand[] {
  return terminalQuickCommandOp('normalizeTerminalQuickCommands', input) as TerminalQuickCommand[]
}

// Type-guard shape is load-bearing: zod infers the narrowed agent type from it.
export function supportsTerminalAgentQuickCommand(
  agent: unknown
): agent is TerminalAgentQuickCommand['agent'] {
  return terminalQuickCommandOp('supportsTerminalAgentQuickCommand', agent) === true
}
