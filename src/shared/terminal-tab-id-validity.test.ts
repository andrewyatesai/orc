// The tree-agnostic tab-id guard has TWO observable states, because its surfaces
// bind the dispatch seam at different times (main/cli/relay at bootstrap, the
// renderer only once the wasm compiles). Both must answer identically: the sole
// consumers are wire/persistence guards, and a spurious `false` rejects a live
// agent session's surface binding or drops a restored terminal tab.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { isValidTerminalTabId } from './terminal-tab-id-validity'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

const CASES: readonly (readonly [string, boolean])[] = [
  ['plain-tab', true],
  ['web-terminal-abc', true], // the base rule does not exclude surface ids
  ['', false],
  ['a:b', false],
  ['host-tab::leaf', false],
  ['tab-\u{1f680}', true] // matched pair: a real astral char must cross the codec
]

afterEach(() => setOrcaDispatchBinding(null))

describe('isValidTerminalTabId (orca-dispatch seam)', () => {
  it('answers the same unbound and bound', () => {
    setOrcaDispatchBinding(null)
    const unbound = CASES.map(([value]) => isValidTerminalTabId(value))

    setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
    const bound = CASES.map(([value]) => isValidTerminalTabId(value))

    expect(unbound).toEqual(CASES.map(([, expected]) => expected))
    expect(bound).toEqual(unbound)
  })

  it('answers a codec-refused id instead of throwing at the wire guard', () => {
    // JSON.stringify emits a lone surrogate as `"\ud800"` — valid JSON text that
    // is not valid UTF-8, so the codec refuses the payload. The deleted twin
    // answered without crossing, and so does this.
    setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
    expect(isValidTerminalTabId('tab-\ud800')).toBe(true)
    expect(isValidTerminalTabId('a:b\ud800')).toBe(false)
  })
})
