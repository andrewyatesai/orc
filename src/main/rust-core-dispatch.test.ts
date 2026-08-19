import { describe, expect, it } from 'vitest'
import { loadRustGitBinding } from './daemon/rust-git-addon'
import { dispatchToRustCore } from './rust-core-dispatch'
import { DispatchPayloadError } from '../shared/dispatch-payload-codec'
import { tokenizeSearchQuery } from './rust-task-query'
import { activeFailureRefetchThrottleMs } from './rust-provider-backoff'
import {
  ACTIVE_FAILURE_REFETCH_BASE_MS,
  MAX_ACTIVE_FAILURE_REFETCH_MS
} from './rate-limits/active-failure-backoff'

// The adoption certificate for the napi half of the dispatch boundary: these run
// the REAL addon through the REAL shims, so they pin what the codec changed about
// a production call rather than re-testing the codec in isolation
// (src/shared/dispatch-payload-codec.test.ts owns that).
//
// The regression under test is the one measured on `task-claim`: a lone UTF-16
// surrogate anywhere in the payload made serde fail, `unwrap_or(Value::Null)`
// turned that into an argument-less call, and the module answered confidently
// against nothing — in the direction that exonerates whatever was being audited.

// Skips cleanly when the .node is absent (CI without a native build).
const suite = loadRustGitBinding() ? describe : describe.skip

const LONE_LEADING = '\ud800'
const ROCKET = '\u{1f680}'

suite('napi dispatch boundary — what a bad payload does now', () => {
  it('rejects a lone surrogate at the call site instead of answering against null', () => {
    // Before: this parsed-failed in serde and ran as a no-arg call, so the module
    // returned a confident wrong answer with nothing logged.
    const poisoned = `is:open ${LONE_LEADING}`
    expect(() => tokenizeSearchQuery(poisoned)).toThrow(DispatchPayloadError)
    expect(() => tokenizeSearchQuery(poisoned)).toThrow(/unpaired UTF-16 surrogate/)
    // And the same call without the surrogate still works, so the guard is not
    // just refusing everything.
    expect(tokenizeSearchQuery('is:open review-requested:@me')).toEqual([
      'is:open',
      'review-requested:@me'
    ])
  })

  it('names the offending field so the shim author can fix it', () => {
    const error = (() => {
      try {
        dispatchToRustCore('task-query', 'tokenizeSearchQuery', { q: `a${LONE_LEADING}b` })
        return null
      } catch (thrown) {
        return thrown as DispatchPayloadError
      }
    })()
    expect(error).toBeInstanceOf(DispatchPayloadError)
    expect(error?.path).toBe('input.q')
  })

  it('lets a real astral character through — a matched pair is not the hazard', () => {
    expect(tokenizeSearchQuery(`${ROCKET} ship`)).toEqual([ROCKET, 'ship'])
  })

  it('throws on an unknown function instead of casting the failure envelope to a result', () => {
    // Before: the `__parity_error__` object came back and was cast to string[].
    expect(() => dispatchToRustCore('task-query', 'tokenzieSearchQuery', 'is:open')).toThrow(
      /tokenzieSearchQuery/
    )
  })

  it('throws on an unknown module', () => {
    expect(() => dispatchToRustCore('no-such-module', 'nope', null)).toThrow(
      /unknown module no-such-module/
    )
  })
})

suite('provider-backoff — the hand-rolled normalisation is still load-bearing', () => {
  // The codec REJECTS NaN/±Infinity, which is the right boundary answer but the
  // wrong domain answer: a non-finite streak has a defined backoff. The shim
  // resolves it before encoding, so these never reach the codec and never throw.
  const BASE = ACTIVE_FAILURE_REFETCH_BASE_MS
  const MAX = MAX_ACTIVE_FAILURE_REFETCH_MS

  it('resolves NaN to the base wait rather than throwing at the boundary', () => {
    expect(activeFailureRefetchThrottleMs(Number.NaN, BASE, MAX)).toBe(BASE)
  })

  it('resolves +Infinity to the CEILING, the direction the boundary would have inverted', () => {
    expect(activeFailureRefetchThrottleMs(Number.POSITIVE_INFINITY, BASE, MAX)).toBe(MAX)
  })

  it('truncates a fractional streak, which Rust reads as i64 and could not decode', () => {
    expect(activeFailureRefetchThrottleMs(2.5, BASE, MAX)).toBe(
      activeFailureRefetchThrottleMs(2, BASE, MAX)
    )
  })
})
