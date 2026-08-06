// Why: text formatters interpolate attacker-controlled strings (web page <title>,
// URLs, OS/app window titles, inter-agent message bodies) straight into output that
// reaches a TTY. Left raw they can carry ESC/CSI/OSC sequences to the terminal
// (cursor/output spoofing, OSC-8 link + OSC-52 clipboard abuse, and prompt-injection
// framing when an agent pipes stdout to an LLM). Neutralizing the C0/C1 controls below
// defuses any escape sequence while leaving its now-inert bytes as printable text.
const TAB = 0x09
const LINE_FEED = 0x0a

function isUntrustedTerminalControlChar(codePoint: number): boolean {
  // C0 controls (0x00-0x1F) except tab, DEL (0x7F), and C1 controls (0x80-0x9F).
  if (codePoint === TAB) {
    return false
  }
  return codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)
}

/** Drop every control character. For single-line contexts that cannot carry newlines. */
export function sanitizeUntrustedTerminalText(value: string): string {
  let result = ''
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (!isUntrustedTerminalControlChar(codePoint)) {
      result += char
    }
  }
  return result
}

/**
 * Render control characters as visible `\xNN` instead of dropping them.
 *
 * Why: dropping is wrong for message bodies — a multi-line body would collapse into
 * one line, and silently deleting bytes hides that someone tried to inject. Escaping
 * keeps the text readable, keeps the injection attempt visible to whoever reads the
 * pane, and still never hands the terminal a live escape sequence.
 */
export function escapeUntrustedTerminalText(
  value: string,
  options?: { allowNewlines?: boolean }
): string {
  const allowNewlines = options?.allowNewlines === true
  let result = ''
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (allowNewlines && codePoint === LINE_FEED) {
      result += char
      continue
    }
    if (!isUntrustedTerminalControlChar(codePoint)) {
      result += char
      continue
    }
    result += `\\x${codePoint.toString(16).padStart(2, '0')}`
  }
  return result
}
