// Why: a newline chord (Shift+Enter / Ctrl+Enter) pressed while an IME
// composition is still open must reach the PTY *after* the composed glyph
// commits. The window-level terminal shortcut handler runs on the keydown, which
// fires before compositionend, so sending the newline there races ahead of the
// pending commit — the composed CJK character is then forwarded after the
// newline and appears pushed down a line. Instead we wait for the composition to
// commit and forward the newline once the glyph is on its way.
import {
  hasPendingTerminalImeComposition,
  XTERM_COMPOSITION_SESSION_END_EVENT
} from './terminal-ime-composition-route'

// Why: compositionend fires within the same event-loop turn as the committing
// key, so a real commit always resolves well under this bound. The fallback only
// guards against an IME that never emits compositionend, so the newline is not
// silently swallowed.
export const TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS = 200

/**
 * Forwards a terminal byte sequence once, after the active IME composition ends.
 *
 * aterm's textarea-level `compositionend` handler sends the committed glyph
 * synchronously, so a bubble-phase listener on the terminal element plus one
 * more macrotask hop orders `send()` strictly after the glyph is on its way.
 * Captured composition transactions (the session route) can outlive that event,
 * so any outstanding session holds the send back until the last one ends. With
 * no terminal element (or no composition to wait on), `send()` runs on the next
 * macrotask so callers get uniform async behavior.
 */
export function sendTerminalInputAfterComposition(
  terminalElement: HTMLElement | null | undefined,
  send: () => void,
  options?: { fallbackMs?: number }
): void {
  if (!terminalElement) {
    window.setTimeout(send, 0)
    return
  }

  const fallbackMs = options?.fallbackMs ?? TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS
  let done = false

  const finish = (): void => {
    if (done) {
      return
    }
    done = true
    terminalElement.removeEventListener('compositionend', onCompositionEnd)
    terminalElement.removeEventListener(
      XTERM_COMPOSITION_SESSION_END_EVENT,
      onCompositionSessionEnd
    )
    window.clearTimeout(fallbackTimer)
    // Defer one macrotask so the engine's post-compositionend glyph forwarding
    // runs before our newline reaches the PTY.
    window.setTimeout(send, 0)
  }

  const finishAfterPendingComposition = (): void => {
    if (!hasPendingTerminalImeComposition(terminalElement)) {
      finish()
    }
  }
  const onCompositionEnd = (): void => finishAfterPendingComposition()
  const onCompositionSessionEnd = (): void => finishAfterPendingComposition()
  // Bubble phase (not capture) so this runs after the engine's textarea-level
  // compositionend handler, keeping our deferred send ordered after its flush.
  terminalElement.addEventListener('compositionend', onCompositionEnd)
  terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onCompositionSessionEnd)
  const fallbackTimer = window.setTimeout(finish, fallbackMs)
}

// Why: the compose-box textarea has no deferred-send bookkeeping to key on, so its
// guard absorbs the re-dispatch by time. A real second press cannot complete a full
// press cycle this quickly after a composing press, so the window can stay this narrow.
export const TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS = 50

export type TerminalImeDeferredNewlineSender = {
  /** Defers `send` until the pane's composition commits and arms one
   *  re-dispatch absorb credit for that exact keystroke. */
  defer: (
    enter: TerminalImeEnterIdentity,
    terminalElement: HTMLElement | null | undefined,
    send: () => void
  ) => void
  /** Returns true when a non-composing Enter is the IME's re-dispatch of a
   *  deferred committing keystroke and must not send a second newline. */
  absorbRedispatchedEnter: (enter: TerminalImeEnterIdentity) => boolean
  releaseRedispatchedEnter: (enter: TerminalImeEnterIdentity) => void
  clearRedispatchedEnters: () => void
}

/** Why code+timeStamp: the re-dispatch is copied from the same native event, so
 *  the pair names that keystroke exactly — no timing window left to expire. */
export type TerminalImeEnterIdentity = Pick<KeyboardEvent, 'code' | 'timeStamp'>

export type TerminalImeModifiedEnterKind = 'shift' | 'ctrl'

export type TerminalImeModifiedEnterChord = TerminalImeEnterIdentity & {
  kind: TerminalImeModifiedEnterKind
}

export type TerminalImeModifiedEnterChordOwner = {
  claim: (chord: TerminalImeModifiedEnterChord) => boolean
  absorb: (chord: TerminalImeModifiedEnterChord) => boolean
  release: (chord: TerminalImeModifiedEnterChord) => void
  clear: () => void
}

// Why: a Windows Process sequence repeats with changing timestamps and blank
// codes, so one chord kind owns the press until the physical key boundary.
export function createTerminalImeModifiedEnterChordOwner(): TerminalImeModifiedEnterChordOwner {
  let activeKind: TerminalImeModifiedEnterKind | null = null

  return {
    claim: ({ kind }) => {
      if (activeKind !== null) {
        return false
      }
      activeKind = kind
      return true
    },
    absorb: ({ kind }) => activeKind === kind,
    release: ({ kind }) => {
      if (activeKind === kind) {
        activeKind = null
      }
    },
    clear: () => {
      activeKind = null
    }
  }
}

export function getTerminalImeModifiedEnterKind(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
): TerminalImeModifiedEnterKind | null {
  if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return 'shift'
  }
  if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey) {
    return 'ctrl'
  }
  return null
}

export function isTerminalImeProcessEnter(
  event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
): boolean {
  return (
    event.key === 'Process' &&
    event.keyCode === 229 &&
    getTerminalImeModifiedEnterKind(event) !== null
  )
}

export function isTerminalImeEnterKeyUp(event: Pick<KeyboardEvent, 'key' | 'keyCode'>): boolean {
  return event.key === 'Enter' && event.keyCode === 13
}

type DeferredNewlineState = {
  inFlightSends: number
  absorbCredits: number
}

/**
 * Wraps sendTerminalInputAfterComposition with per-keystroke re-dispatch tracking.
 *
 * macOS Hangul delivers a committing Shift/Ctrl+Enter twice: first as an IME
 * keydown (`keyCode 229, isComposing=true`), then — about 2 ms after
 * compositionend — as a re-dispatched plain keydown (`keyCode 13,
 * isComposing=false`). Deferring only the first press still lets the
 * re-dispatch send its newline immediately, which both races ahead of the
 * engine's pending glyph flush and doubles the newline once the deferred send
 * fires.
 */
export function createTerminalImeDeferredNewlineSender(): TerminalImeDeferredNewlineSender {
  const statesByEnterCode = new Map<string, Map<number, DeferredNewlineState>>()

  const cleanUpIfSettled = (enter: TerminalImeEnterIdentity, state: DeferredNewlineState): void => {
    if (state.inFlightSends <= 0 && state.absorbCredits <= 0) {
      const statesByTimeStamp = statesByEnterCode.get(enter.code)
      statesByTimeStamp?.delete(enter.timeStamp)
      if (statesByTimeStamp?.size === 0) {
        statesByEnterCode.delete(enter.code)
      }
    }
  }

  const clearCreditsForCode = (enterCode: string): void => {
    const statesByTimeStamp = statesByEnterCode.get(enterCode)
    if (!statesByTimeStamp) {
      return
    }
    for (const [timeStamp, state] of statesByTimeStamp) {
      state.absorbCredits = 0
      cleanUpIfSettled({ code: enterCode, timeStamp }, state)
    }
  }

  return {
    defer: (enter, terminalElement, send) => {
      const statesByTimeStamp = statesByEnterCode.get(enter.code) ?? new Map()
      const state = statesByTimeStamp.get(enter.timeStamp) ?? {
        inFlightSends: 0,
        absorbCredits: 0
      }
      state.inFlightSends += 1
      state.absorbCredits += 1
      statesByTimeStamp.set(enter.timeStamp, state)
      statesByEnterCode.set(enter.code, statesByTimeStamp)
      sendTerminalInputAfterComposition(terminalElement, () => {
        state.inFlightSends -= 1
        cleanUpIfSettled(enter, state)
        send()
      })
    },
    absorbRedispatchedEnter: (enter) => {
      const state = statesByEnterCode.get(enter.code)?.get(enter.timeStamp)
      if (!state || state.absorbCredits <= 0) {
        clearCreditsForCode(enter.code)
        return false
      }
      state.absorbCredits -= 1
      cleanUpIfSettled(enter, state)
      return true
    },
    releaseRedispatchedEnter: (enter) => {
      if (statesByEnterCode.get(enter.code)?.has(enter.timeStamp)) {
        // Chromium's balancing Process-key keyup is copied from the same native event.
        return
      }
      clearCreditsForCode(enter.code)
    },
    clearRedispatchedEnters: () => {
      for (const enterCode of statesByEnterCode.keys()) {
        clearCreditsForCode(enterCode)
      }
    }
  }
}
