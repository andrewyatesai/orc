// @vitest-environment happy-dom
// An input source that substitutes text for a printable key commits it through a
// bare `insertText` with no composition session. This drives the forwarder and
// bypass policy wired exactly the way use-terminal-pane-lifecycle wires
// attachCustomKeyEventHandler, so it covers the whole keydown -> input path that
// reaches the pty. The engine encoder is modelled by one rule — an unclaimed
// printable keydown is sent raw — which is what makes "the committed text, not
// the raw layout character" an observable outcome rather than an assertion about
// internals.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { shouldBypassXtermKeyboardEvent } from './xterm-bypass-policy'

type SubstitutionCase = {
  name: string
  code: string
  keyCode: number
  shiftKey?: boolean
  layoutText: string
  imeText: string
}

type Harness = {
  element: HTMLDivElement
  textarea: HTMLTextAreaElement
  sentToPty: string[]
  forwarder: ReturnType<typeof installTerminalImeNativeTextForwarder>
  handleKeyEvent: (event: KeyboardEvent) => boolean
}

function open(): Harness {
  const element = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  element.appendChild(textarea)
  document.body.appendChild(element)

  const sentToPty: string[] = []
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: element,
    isComposing: () => false,
    sendInput: (data) => sentToPty.push(data)
  })

  // Mirrors the lifecycle wiring: the forwarder gets first refusal, then the
  // bypass policy decides. Returning false stands the engine encoder down;
  // returning true lets it run — the same contract attachCustomKeyEventHandler has.
  const handleKeyEvent = (event: KeyboardEvent): boolean => {
    if (forwarder.claimKeyEvent(event)) {
      return false
    }
    return !shouldBypassXtermKeyboardEvent(event, { isMac: true, hasSelection: false })
  }

  return { element, textarea, sentToPty, forwarder, handleKeyEvent }
}

function keyboardEvent(
  type: string,
  init: { key: string; code: string; keyCode: number; shiftKey: boolean }
): KeyboardEvent {
  const ev = new KeyboardEvent(type, {
    key: init.key,
    code: init.code,
    shiftKey: init.shiftKey,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(ev, 'keyCode', { value: init.keyCode })
  return ev
}

function insertText(textarea: HTMLTextAreaElement, data: string): void {
  textarea.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
}

// Returns whether the engine encoder would have run for the keydown, so a test
// can pin that the substitution reaches the pty before any protocol encoder does.
function press(h: Harness, c: SubstitutionCase): boolean {
  const shiftKey = c.shiftKey === true
  const keydown = keyboardEvent('keydown', {
    key: c.layoutText,
    code: c.code,
    keyCode: c.keyCode,
    shiftKey
  })
  const engineWillEncode = h.handleKeyEvent(keydown)
  if (engineWillEncode) {
    // The keydown was not claimed: the engine sends the raw layout character.
    if (c.layoutText.length === 1) {
      h.sentToPty.push(c.layoutText)
    }
  } else {
    // The engine stood down; the committed text arrives on the input event. The
    // keypress is claimed too so the engine cannot double-send the ASCII source.
    if (c.imeText.length === 1) {
      h.handleKeyEvent(
        keyboardEvent('keypress', {
          key: c.imeText,
          code: c.code,
          keyCode: c.imeText.charCodeAt(0),
          shiftKey
        })
      )
    }
    h.textarea.value = c.imeText
    insertText(h.textarea, c.imeText)
  }
  h.handleKeyEvent(
    keyboardEvent('keyup', { key: c.layoutText, code: c.code, keyCode: c.keyCode, shiftKey })
  )
  return engineWillEncode
}

function type(cases: SubstitutionCase[]): { sent: string; enginePressed: boolean } {
  const h = open()
  let enginePressed = false
  for (const c of cases) {
    if (press(h, c)) {
      enginePressed = true
    }
  }
  h.forwarder.dispose()
  return { sent: h.sentToPty.join(''), enginePressed }
}

const COMMA: SubstitutionCase = { name: 'comma', code: 'Comma', keyCode: 188, layoutText: ',', imeText: '，' }
const PERIOD: SubstitutionCase = { name: 'period', code: 'Period', keyCode: 190, layoutText: '.', imeText: '。' }
const QUESTION: SubstitutionCase = {
  name: 'question',
  code: 'Slash',
  keyCode: 191,
  shiftKey: true,
  layoutText: '?',
  imeText: '？'
}
const BACKSLASH: SubstitutionCase = {
  name: 'ideographic comma',
  code: 'Backslash',
  keyCode: 220,
  layoutText: '\\',
  imeText: '、'
}
const EM_DASH: SubstitutionCase = {
  name: 'em dash pair',
  code: 'Minus',
  keyCode: 189,
  shiftKey: true,
  layoutText: '_',
  imeText: '——'
}
const FULLWIDTH_ONE: SubstitutionCase = {
  name: 'full-width one',
  code: 'Digit1',
  keyCode: 49,
  layoutText: '1',
  imeText: '１'
}
const TELEX_A: SubstitutionCase = {
  name: 'telex a-acute',
  code: 'KeyS',
  keyCode: 83,
  layoutText: 's',
  imeText: 'á'
}

describe('input-source text substitution reaches the terminal', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('sends the substituted sentence tail, not the raw layout characters', () => {
    expect(type([COMMA, PERIOD, PERIOD]).sent).toBe('，。。')
  })
  it('sends a shifted substitution', () => {
    expect(type([QUESTION]).sent).toBe('？')
  })
  it('sends the backslash-position substitution (#10896)', () => {
    expect(type([BACKSLASH]).sent).toBe('、')
  })
  it('sends a multi-code-unit substitution from one press', () => {
    expect(type([EM_DASH]).sent).toBe('——')
  })
  it('sends a full-width digit substitution', () => {
    expect(type([FULLWIDTH_ONE]).sent).toBe('１')
  })
  it('sends a letter substitution', () => {
    expect(type([TELEX_A]).sent).toBe('á')
  })

  // The forwarder reads no protocol state, so it claims the printable keydown
  // before any encoder runs. That is what carries the substitution raw even for a
  // pane that negotiated kitty "all keys as escape codes" — a deliberate trade,
  // preferring the committed character to protocol fidelity. Pinned here because
  // the fork has no kitty branch in this path to gate on if it ever needs closing.
  it('claims the keydown before the engine encoder, so no raw or escaped byte leaks', () => {
    const { sent, enginePressed } = type([COMMA])
    expect(sent).toBe('，')
    expect(enginePressed).toBe(false)
  })
})
