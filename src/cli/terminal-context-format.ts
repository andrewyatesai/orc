/**
 * Human-readable rendering for the terminal context verbs. Split from
 * terminal-format.ts (line budget) and kept together because all four share the
 * blind-spot footer: the non-JSON view must not read as if the pane were fully
 * observed when it was not.
 */
import type {
  TerminalAgentView,
  TerminalCommandBlockSummary,
  TerminalCommandBlockText,
  TerminalCommandBlocksResult,
  TerminalContextBlindSpot,
  TerminalHistoryWindow
} from '../shared/terminal-context-protocol'
import type {
  AgentTranscriptBlock,
  AgentTranscriptHost,
  AgentTranscriptTurn,
  TerminalAgentTranscript
} from '../shared/agent-transcript-protocol'
import type { RemoteTerminalSearchResult } from '../shared/terminal-remote-search-protocol'
import { sanitizeUntrustedTerminalText } from './terminal-safe-text'

function blindSpotFooter(blindSpots: readonly TerminalContextBlindSpot[]): string {
  if (blindSpots.length === 0) {
    return ''
  }
  const names = blindSpots.map((spot) => `${spot.capability} (${spot.reason})`).join(', ')
  return `\n\nnot visible here: ${names}`
}

function terminalLines(lines: readonly string[]): string {
  return lines.map((line) => sanitizeUntrustedTerminalText(line)).join('\n')
}

export function formatTerminalHistory(result: TerminalHistoryWindow): string {
  if (!result.available) {
    return `History unavailable: ${result.unavailable ?? 'unknown'}.`
  }
  const range =
    result.firstHostRow === null
      ? 'no rows in this window'
      : `rows ${result.firstHostRow}-${result.firstHostRow + result.rows.length - 1}`
  const scope = `retained ${result.oldestHostRow ?? 0}-${result.latestHostRow ?? 0} (${result.totalRows} rows incl. screen)`
  const paging = [
    result.previousHostRow !== null ? `older: --from ${result.previousHostRow}` : null,
    result.nextHostRow !== null ? `newer: --from ${result.nextHostRow}` : null,
    result.evicted ? 'evicted: requested rows are below the retained floor' : null,
    result.limited ? 'limited: window trimmed to the byte budget' : null
  ]
    .filter((entry): entry is string => entry !== null)
    .join('  |  ')
  const header = `${range}  of  ${scope}${paging ? `\n${paging}` : ''}`
  return `${header}\n\n${terminalLines(result.rows)}${blindSpotFooter(result.blindSpots)}`
}

function formatBlockLine(block: TerminalCommandBlockSummary): string {
  const state = block.running
    ? 'running'
    : `exit ${block.exitCode === null ? 'unknown' : block.exitCode}`
  const span =
    block.endCursor === null
      ? `cursor ${block.startCursor}+`
      : `cursor ${block.startCursor}-${block.endCursor}`
  const command = block.command === null ? '(command not reported)' : block.command
  return `#${block.index}  ${state}  ${span}  ${sanitizeUntrustedTerminalText(command)}`
}

export function formatTerminalBlocks(result: TerminalCommandBlocksResult): string {
  if (!result.available) {
    return `Command blocks unavailable: ${result.unavailable ?? 'unknown'}.`
  }
  if (result.blocks.length === 0) {
    // Why this exact wording: absence of blocks is genuinely ambiguous from the
    // byte stream, and a driver must not read it as "the shell ran nothing".
    return `No command blocks recorded. Either no command has run yet, this shell emits no OSC 133, or this pane is inside an agent TUI (an agent CLI is one block for its whole session).${blindSpotFooter(result.blindSpots)}`
  }
  const body = result.blocks.map(formatBlockLine).join('\n')
  const footer = `\n\n${result.blocks.length} shown of ${result.totalObserved} observed (${result.evictedCount} evicted); transcript cursors ${result.oldestCursor}-${result.latestCursor}`
  return `${body}${footer}${blindSpotFooter(result.blindSpots)}`
}

export function formatTerminalBlockText(result: TerminalCommandBlockText): string {
  if (result.outcome === 'no-such-block') {
    return 'No such command block.'
  }
  if (result.outcome === 'no-pty-record') {
    return 'No transcript record for this terminal.'
  }
  const header = result.block ? formatBlockLine(result.block) : '(no block)'
  if (result.outcome === 'evicted') {
    return `${header}\n\nOutput evicted: this block's lines aged out of the retained transcript.`
  }
  const flags = [
    result.running ? 'still running (output so far)' : null,
    result.truncated ? 'truncated: older lines of this block were evicted' : null,
    result.limited ? 'limited: trimmed to the line/byte budget' : null
  ]
    .filter((entry): entry is string => entry !== null)
    .join('  |  ')
  const body = result.lines.length === 0 ? '(no output)' : terminalLines(result.lines)
  return `${header}${flags ? `\n${flags}` : ''}\n\n${body}${blindSpotFooter(result.blindSpots)}`
}

export function formatTerminalAgentView(result: TerminalAgentView): string {
  const agent = `agent: ${result.agent.isRunningAgent ? 'running' : 'not running'}${result.agent.status ? ` (${result.agent.status})` : ''}`
  const screen = result.screen.available
    ? `screen: ${result.screen.cols}x${result.screen.rowCount}${result.screen.alternateScreen ? ' alt' : ''}${result.screen.cursor ? ` cursor ${result.screen.cursor.row},${result.screen.cursor.col}` : ''}`
    : 'screen: unavailable (no live engine for this pane)'
  const history = result.history.available
    ? `history: ${result.history.scrollbackRows} rows above${result.history.hasMoreAbove ? ` — orca terminal history --from ${result.history.oldestHostRow}` : ''}`
    : 'history: unavailable'
  const block = result.lastBlock
    ? `last block: ${formatBlockLine(result.lastBlock)}`
    : 'last block: none recorded'
  const head = [`status: ${result.status}`, agent, screen, history, block].join('\n')
  const body = result.screen.available ? `\n\n${terminalLines(result.screen.rows)}` : ''
  return `${head}${body}${blindSpotFooter(result.blindSpots)}`
}

function formatTranscriptHost(host: AgentTranscriptHost): string {
  if (host.kind === 'ssh') {
    return `ssh ${host.connectionId}`
  }
  return host.kind === 'wsl' ? `wsl ${host.distro ?? 'unknown-distro'}` : 'local'
}

function formatTranscriptBlock(block: AgentTranscriptBlock): string {
  const cut = 'truncated' in block && block.truncated ? ' [truncated]' : ''
  if (block.kind === 'text') {
    return `${terminalLines(block.text.split('\n'))}${cut}`
  }
  if (block.kind === 'tool-call') {
    return `[tool-call ${sanitizeUntrustedTerminalText(block.name)}] ${terminalLines(block.input.split('\n'))}${cut}`
  }
  if (block.kind === 'tool-result') {
    return `[tool-result${block.isError ? ' error' : ''}]\n${terminalLines(block.output.split('\n'))}${cut}`
  }
  return `[image ${sanitizeUntrustedTerminalText(block.ref ?? block.alt ?? 'unnamed')}]`
}

function formatTranscriptTurn(turn: AgentTranscriptTurn): string {
  return `${turn.role}: ${turn.blocks.map(formatTranscriptBlock).join('\n')}`
}

export function formatTerminalAgentTranscript(result: TerminalAgentTranscript): string {
  const identity = `agent: ${result.agent ?? 'unknown'}  session: ${result.sessionId ?? 'unknown'}  host: ${formatTranscriptHost(result.host)}`
  if (!result.available) {
    // Why this shape: the reason token, the sentence, and the identity Orca DID
    // resolve — so "I could not look" never reads as "the agent said nothing".
    return `Agent transcript unavailable: ${result.unavailable ?? 'unknown'}.\n${result.detail ?? ''}\n${identity}${result.path ? `\nreported path: ${result.path}` : ''}`
  }
  const paging = [
    result.hasMoreBefore && result.previousOffset !== null
      ? `older: --before ${result.previousOffset}`
      : null,
    result.limited ? 'limited: bodies trimmed to the character budget' : null
  ]
    .filter((entry): entry is string => entry !== null)
    .join('  |  ')
  const header = `${identity}\n${result.path}\n${result.turns.length} turn(s)${paging ? `  |  ${paging}` : ''}`
  const body =
    result.turns.length === 0
      ? 'This transcript exists and records no turns yet.'
      : result.turns.map(formatTranscriptTurn).join('\n\n')
  return `${header}\n\n${body}${blindSpotFooter(result.blindSpots)}`
}

export function formatTerminalSearch(result: RemoteTerminalSearchResult): string {
  if (!result.available) {
    return 'Search unavailable for this terminal (no live engine state).'
  }
  if (result.matches.length === 0) {
    return 'No matches.'
  }
  const body = result.matches
    .map(
      (match) =>
        `row ${match.hostRow} col ${match.col}  ${sanitizeUntrustedTerminalText(match.line)}`
    )
    .join('\n')
  const footer = `\n\n${result.matches.length} shown of ${result.total}${result.incomplete ? ' (capped)' : ''}; read around one with: orca terminal history --from <row>`
  return `${body}${footer}`
}
