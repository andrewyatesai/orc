// The divergence a fallback-vs-core differential structurally cannot see.
//
// The cutover's own proof compared the shim's pre-ready fallback against the
// Rust core over 71,771 inputs and found nothing, because BOTH answer the same
// thing — but neither was compared against the twin with the seam BOUND. An
// Array reaches the twin's `.indexOf` and answers null; it reaches the core's
// adapter and comes back "expects a string", which the bound seam turns into a
// throw. Non-string ids arrive here from persisted JSON and off the relay wire.
//
// Watched failing before the guard landed: both cases threw DispatchCoreError.
import { describe, expect, it } from 'vitest'
import { makePaneKey, parsePaneKey } from './stable-pane-identity'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

const LEAF = '11111111-1111-4111-8111-111111111111'

describe('non-string inputs answer the twin in BOTH seam states', () => {
  it('unbound', () => {
    expect(parsePaneKey([] as never)).toBeNull()
    expect(makePaneKey([] as never, LEAF)).toBe(`:${LEAF}`)
  })
  it('bound', () => {
    // The global setup already ran initSync; rebinding is just the callback,
    // matching stable-pane-identity.test.ts.
    setOrcaDispatchBinding((module, fn, input) => orcaDispatch(module, fn, input))
    expect(parsePaneKey([] as never)).toBeNull()
    expect(parsePaneKey(['tab-1:12'] as never)).toBeNull()
    expect(makePaneKey([] as never, LEAF)).toBe(`:${LEAF}`)
    expect(parsePaneKey(`tab-1:${LEAF}`)).toEqual({
      tabId: 'tab-1',
      leafId: LEAF,
      stablePaneId: LEAF
    })
  })
})
