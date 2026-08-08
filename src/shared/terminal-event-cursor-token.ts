/**
 * Wire form for an EventCursor (§3a/§5.3 of
 * docs/reference/alab-auto-mode-design.md) on the CLI.
 *
 * Opaque on purpose. A cursor is a position this runtime issued; a caller that
 * hand-assembled one would be asserting a pane history it cannot know, and the
 * journal would have to gap it anyway. Callers echo back what they were given.
 */

export type TerminalEventCursorToken = {
  runtimeId: string
  ptyIncarnationId: string
  eventSeq: number
}

export function encodeTerminalEventCursor(cursor: TerminalEventCursorToken): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** null for anything this module did not issue — never a coerced cursor, which
 *  would silently resume a reader at the wrong place. */
export function decodeTerminalEventCursor(token: string): TerminalEventCursorToken | null {
  try {
    const raw: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    if (typeof raw !== 'object' || raw === null) {
      return null
    }
    const { runtimeId, ptyIncarnationId, eventSeq } = raw as Record<string, unknown>
    if (
      typeof runtimeId !== 'string' ||
      typeof ptyIncarnationId !== 'string' ||
      typeof eventSeq !== 'number' ||
      !Number.isInteger(eventSeq) ||
      eventSeq < 0
    ) {
      return null
    }
    return { runtimeId, ptyIncarnationId, eventSeq }
  } catch {
    return null
  }
}
