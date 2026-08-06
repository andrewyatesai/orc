import {
  escapeUntrustedTerminalText,
  sanitizeUntrustedTerminalText
} from '../../../shared/terminal-safe-text'
import type { MessageRow } from './types'

const BANNER_WIDTH = 60
const SEPARATOR = '─'.repeat(BANNER_WIDTH)

// Why: this banner is written straight into a live PTY (orca-runtime.ts:29776), and
// every field below comes from whoever sent the message — any agent that can reach
// `orca orchestration send`. Raw, a body could carry OSC-52 to write the receiving
// user's clipboard, OSC-8 to disguise a link, or CSI to redraw the pane and frame a
// fake instruction for the reading agent. Escape on render so no caller can forget.
const singleLine = (value: string): string => sanitizeUntrustedTerminalText(value)
const multiLine = (value: string): string =>
  escapeUntrustedTerminalText(value, { allowNewlines: true })

// Why: rich message banners help agents (and humans reading terminal output)
// quickly parse message metadata. Priority indicators surface urgent messages
// visually. The reply hint reduces friction for agent-to-agent responses
// (Section 4.8).
export function formatMessageBanner(msg: MessageRow): string {
  const priorityTag =
    msg.priority === 'urgent' ? ' [URGENT]' : msg.priority === 'high' ? ' [HIGH]' : ''
  const fromHandle = singleLine(msg.from_handle)
  const senderName = fromHandle.toUpperCase()

  const header = `──── From: ${senderName} (${fromHandle})${priorityTag} (${singleLine(msg.type)}) ────`

  const lines: string[] = [header]
  lines.push(`Subject: ${singleLine(msg.subject)}`)

  if (msg.body) {
    lines.push(multiLine(msg.body))
  }

  if (msg.payload) {
    lines.push(`[Payload: ${multiLine(msg.payload)}]`)
  }

  // Why: injected reply commands must retain the receiving pane's identity
  // even when an older shell lacks Orca's terminal environment variables.
  lines.push(
    `[Reply: orca orchestration reply --id ${msg.id} --from ${singleLine(msg.to_handle)} --body "..."]`
  )
  lines.push(SEPARATOR)

  return lines.join('\n')
}

// Why: grouping multiple banners under a single wrapper line lets agents detect
// the message block boundary and parse each banner individually.
export function formatMessagesForInjection(messages: MessageRow[]): string {
  if (messages.length === 0) {
    return ''
  }

  const banners = messages.map(formatMessageBanner).join('\n\n')
  return `\n--- Orchestration Messages (${messages.length}) ---\n${banners}\n---\n`
}
