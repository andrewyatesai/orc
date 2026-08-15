// Deliberately does NOT import './init-git-wasm-for-test' at the top: this file
// exists to observe the shim BEFORE the core is ready.
//
// terminal-tab-id is the identity case. Both predicates gate WHICH id a terminal
// lives under, and every call site consumes the bare boolean inside `&&` or
// `.filter(...)` — so a `null`/`undefined` sentinel is just a falsy `false` there,
// with no branch to hang off. That leaves exactly one lawful pre-ready value:
// the twin's answer, for every input. These cases pin both directions (a wrong
// `true` and a wrong `false` each break identity) plus the one input class the
// dispatch codec refuses.
import { describe, expect, it } from 'vitest'
import { getGitWasmAvailability } from './git-wasm-availability'
import { isValidHostTerminalTabId, isValidTerminalTabId } from './terminal-tab-id'

// An id JSON.stringify emits as `"\ud800"` — valid JSON text, not valid UTF-8, so
// the codec refuses it rather than letting serde fail on the whole payload. It can
// reach here from persisted session JSON or a web/mobile client.
const LONE_SURROGATE_TAB_ID = 'tab-\ud800'

describe('terminal-tab-id pre-ready value', () => {
  it('answers exactly as the deleted twin while the core is pending', () => {
    expect(getGitWasmAvailability()).toBe('pending')

    expect(isValidTerminalTabId('plain-tab')).toBe(true)
    expect(isValidTerminalTabId('web-terminal-abc')).toBe(true)
    expect(isValidTerminalTabId('')).toBe(false)
    expect(isValidTerminalTabId('a:b')).toBe(false)
    expect(isValidTerminalTabId('host-tab::leaf')).toBe(false)

    expect(isValidHostTerminalTabId('plain-tab')).toBe(true)
    expect(isValidHostTerminalTabId('web-terminal-abc')).toBe(false)
    expect(isValidHostTerminalTabId('a:b')).toBe(false)
    expect(isValidHostTerminalTabId('')).toBe(false)
  })

  it('does not throw on an id the dispatch codec refuses, in either state', async () => {
    // Pre-ready never encodes, so this only proves the fallback is total...
    expect(isValidTerminalTabId(LONE_SURROGATE_TAB_ID)).toBe(true)

    await import('./init-git-wasm-for-test')
    expect(getGitWasmAvailability()).toBe('ready')

    // ...and this is the one that matters: ready, the shim DOES try to encode,
    // the codec rejects, and the shim answers with the twin's answer instead of
    // throwing out of a Zustand set() / an IPC handler.
    expect(isValidTerminalTabId(LONE_SURROGATE_TAB_ID)).toBe(true)
    expect(isValidHostTerminalTabId(LONE_SURROGATE_TAB_ID)).toBe(true)
    expect(isValidTerminalTabId(`a:b\ud800`)).toBe(false)
  })

  it('gives the same answers once the core lands (parity, not a coincidence)', () => {
    expect(getGitWasmAvailability()).toBe('ready')

    expect(isValidTerminalTabId('plain-tab')).toBe(true)
    expect(isValidTerminalTabId('web-terminal-abc')).toBe(true)
    expect(isValidTerminalTabId('')).toBe(false)
    expect(isValidTerminalTabId('a:b')).toBe(false)
    expect(isValidTerminalTabId('host-tab::leaf')).toBe(false)

    expect(isValidHostTerminalTabId('plain-tab')).toBe(true)
    expect(isValidHostTerminalTabId('web-terminal-abc')).toBe(false)
    expect(isValidHostTerminalTabId('a:b')).toBe(false)
    expect(isValidHostTerminalTabId('')).toBe(false)

    // A matched surrogate pair is a real astral character and must still cross.
    expect(isValidTerminalTabId('tab-🚀')).toBe(true)
  })
})
