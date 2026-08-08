/**
 * Scrapes a pane's own output for the provider telling it the subscription is
 * spent, and turns that into the `provider-limit` fact (§12 R0 of
 * docs/reference/alab-auto-mode-design.md). R1's health service subscribes to
 * it; without it, exhaustion is only observable by polling a usage fetcher.
 *
 * Renderer-independent on purpose. The other per-chunk scrapes (bell, OSC 133,
 * PR links, Command Code) are skipped headlessly as a deliberate perf decision,
 * but a fleet running under `orca serve` is exactly where exhaustion matters, so
 * §5.3 sanctions arming this one per health-relevant PTY.
 *
 * Conservative by construction: an unmatched notice yields nothing. A false
 * positive is worse than a miss here — it would make R1 rotate away from a
 * healthy account, spending a second subscription to fix an imaginary problem.
 */

import { parseResetTimestamp } from '../rate-limits/claude-pty-reset-parser'
import { stripTerminalControl } from '../../shared/terminal-control-sequence-strip'

/** Deliberately vendor-neutral. Per-CLI banner strings were not used because
 *  only claude/codex/grok/gemini are verifiable on this machine and inventing
 *  the rest would certify what nobody observed (the §5.2a standard). */
const LIMIT_MARKERS: readonly RegExp[] = [
  /\busage limit reached\b/i,
  /\byou'?ve (?:hit|reached|used up) (?:your|the)\b[^.]{0,40}\blimit\b/i,
  /\brate limit(?:ed)? exceeded\b/i,
  /\bquota exceeded\b/i,
  /\bout of (?:credits|quota)\b/i,
  /\binsufficient (?:credits|quota)\b/i
]

/**
 * Rejects the same phrases when they are being *described* rather than reported —
 * a queued prompt, a grep hit, a diff hunk, or the agent explaining the error.
 *
 * The diff cases matter most and are the easiest to miss: an agent running
 * `git diff` over this very file prints `+ /usage limit reached/i` and
 * `- '...usage limit reached...'`. Without `+`/`-` here, reviewing this detector
 * would trip it, and a future router would rotate a perfectly healthy account.
 */
const QUOTED_CONTEXT_RE = /^\s*(?:[>›»|#*+-]|\/\/|\/\*|@@|\d+:|[a-zA-Z0-9_./-]+:\d+:)/
/** A line that quotes the phrase inside a string or regex literal is source
 *  code being displayed, not a provider speaking. */
const CODE_LITERAL_RE = /['"`/]\s*[^'"`/]{0,40}(?:usage limit|rate limit|quota)/i

const RESET_CLAUSE_RE = /\bresets?\s+(?:at\s+|in\s+|on\s+)?([^.\n\r]{1,80})/i
const MAX_LINE_LENGTH = 2_000
/** A repainting TUI redraws the same banner many times a second; one episode is
 *  one fact until the notice changes or the window lapses. */
const DEFAULT_REPEAT_SUPPRESSION_MS = 60_000

export type ProviderLimitObservation = {
  /** Free text as observed, normalized — the evidence, not a decision. */
  message: string
  resetsAt: number | null
  resetDescription: string | null
}

export type ProviderLimitOutputDetector = {
  observe: (data: string) => boolean
  reset: () => void
}

function normalizeLine(line: string): string {
  return stripTerminalControl(line).replace(/\s+/g, ' ').trim()
}

/** null when this line is not a provider reporting exhaustion. */
export function extractProviderLimit(rawLine: string): ProviderLimitObservation | null {
  const line = normalizeLine(rawLine).slice(0, MAX_LINE_LENGTH)
  if (!line || QUOTED_CONTEXT_RE.test(line) || CODE_LITERAL_RE.test(line)) {
    return null
  }
  if (!LIMIT_MARKERS.some((marker) => marker.test(line))) {
    return null
  }
  const resetMatch = RESET_CLAUSE_RE.exec(line)
  const resetDescription = resetMatch ? resetMatch[1].replace(/[)\s│]+$/, '').trim() : null
  return {
    message: line,
    resetsAt: parseResetTimestamp(resetDescription),
    resetDescription
  }
}

export function createProviderLimitOutputDetector(args: {
  onLimit: (observation: ProviderLimitObservation) => void
  repeatSuppressionMs?: number
  now?: () => number
}): ProviderLimitOutputDetector {
  const suppressionMs = args.repeatSuppressionMs ?? DEFAULT_REPEAT_SUPPRESSION_MS
  const now = args.now ?? Date.now
  let carry = ''
  let lastMessage: string | null = null
  let lastAt = 0

  const emit = (observation: ProviderLimitObservation): boolean => {
    const at = now()
    if (observation.message === lastMessage && at - lastAt < suppressionMs) {
      lastAt = at
      return false
    }
    lastMessage = observation.message
    lastAt = at
    args.onLimit(observation)
    return true
  }

  return {
    observe(data: string): boolean {
      // Why split on both: TUIs redraw with bare \r, so a banner can arrive
      // without ever producing a \n and would otherwise sit in carry forever.
      const combined = carry + data
      const parts = combined.split(/\r\n|\r|\n/)
      carry = (parts.pop() ?? '').slice(-MAX_LINE_LENGTH)
      let emitted = false
      for (const part of parts) {
        const observation = extractProviderLimit(part)
        if (observation && emit(observation)) {
          emitted = true
        }
      }
      // The unterminated tail still counts — a repainted banner may never end.
      const tail = extractProviderLimit(carry)
      if (tail && emit(tail)) {
        emitted = true
      }
      return emitted
    },
    reset(): void {
      carry = ''
      lastMessage = null
      lastAt = 0
    }
  }
}
