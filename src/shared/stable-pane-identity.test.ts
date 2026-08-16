// The twin's suite, moved verbatim onto the shim (config/vitest-orca-dispatch-seam.ts
// binds the seam, so these run against the real Rust core), plus the guards the
// shim adds at the boundary. Each guard has a paired unbound-seam assertion:
// pre-ready must equal ready, which is what makes the `parity` declaration true.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  isStablePaneId,
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from './stable-pane-identity'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

/** The global setup already ran `initSync`, so rebinding is just the callback. */
function rebindSeam(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `read` with no binding installed — the renderer's pre-wasm window, and
 *  the permanent state of any surface whose core failed to load. */
function withUnboundSeam<T>(read: () => T): T {
  setOrcaDispatchBinding(null)
  return read()
}

afterEach(() => {
  rebindSeam()
})

describe('stable pane ids', () => {
  it('recognizes UUID leaf ids as stable pane ids', () => {
    expect(isStablePaneId(LEAF_ID)).toBe(true)
    expect(isTerminalLeafId(LEAF_ID)).toBe(true)
  })

  it('rejects legacy numeric pane ids and malformed UUIDs', () => {
    for (const value of ['1', 'pane:1', '11111111-1111-6111-8111-111111111111', '']) {
      expect(isStablePaneId(value)).toBe(false)
      expect(isTerminalLeafId(value)).toBe(false)
    }
  })

  it('builds and parses pane keys using the tab id and UUID leaf id', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)

    expect(paneKey).toBe(`tab-1:${LEAF_ID}`)
    expect(parsePaneKey(paneKey)).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID
    })
  })

  it('rejects ambiguous tab ids and non-UUID leaf ids when building keys', () => {
    expect(() => makePaneKey('', LEAF_ID)).toThrow(/tabId/)
    expect(() => makePaneKey('tab:1', LEAF_ID)).toThrow(/tabId/)
    expect(() => makePaneKey('tab-1', '1')).toThrow(/UUID/)
  })

  it('rejects ambiguous or legacy pane-key inputs when parsing', () => {
    expect(parsePaneKey('tab-1:1')).toBeNull()
    expect(parsePaneKey(`tab:1:${LEAF_ID}`)).toBeNull()
    expect(parsePaneKey(`:${LEAF_ID}`)).toBeNull()
    expect(parsePaneKey('tab-1:')).toBeNull()
  })

  it('parses legacy numeric pane keys only for migration aliases', () => {
    expect(parseLegacyNumericPaneKey(' tab-1:12 ')).toEqual({
      tabId: 'tab-1',
      numericPaneId: '12',
      paneKey: 'tab-1:12'
    })
    expect(parseLegacyNumericPaneKey(`tab-1:${LEAF_ID}`)).toBeNull()
    expect(parseLegacyNumericPaneKey('tab:1:12')).toBeNull()
  })
})

describe('stable-pane-identity boundary', () => {
  // persistence.ts registerLegacyAlias, useIpcEvents tryMakePaneKey and
  // aterm-pane-open all catch this bare, so the throw is the contract; the
  // message is pinned because the Rust `Err` must equal it verbatim.
  it('throws the twin’s exact messages, bound and unbound alike', () => {
    for (const read of [() => makePaneKey('', LEAF_ID), () => makePaneKey('tab:1', LEAF_ID)]) {
      expect(read).toThrow('tabId must be non-empty and must not contain ":"')
      expect(() => withUnboundSeam(read)).toThrow(
        'tabId must be non-empty and must not contain ":"'
      )
      rebindSeam()
    }
    expect(() => makePaneKey('tab-1', '')).toThrow('stableLeafId must be a UUID')
    // Uppercase hex: the twin's regex carried no `i` flag, so this is not a leaf id.
    expect(() =>
      withUnboundSeam(() => makePaneKey('tab-1', '11111111-1111-4111-8111-11111111111A'))
    ).toThrow('stableLeafId must be a UUID')
  })

  // A tab id or a leaf id can hold an unpaired surrogate (persisted JSON, the
  // relay wire); the codec cannot encode one, and the twin never crossed a
  // boundary to answer it.
  it('answers a lone surrogate locally instead of failing the encode', () => {
    const loneSurrogate = '\ud800tab'
    expect(makePaneKey(loneSurrogate, LEAF_ID)).toBe(`${loneSurrogate}:${LEAF_ID}`)
    expect(isStablePaneId(loneSurrogate)).toBe(false)
    expect(parsePaneKey(`${loneSurrogate}:${LEAF_ID}`)).toEqual({
      tabId: loneSurrogate,
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID
    })
    expect(parseLegacyNumericPaneKey(`${loneSurrogate}:12`)).toEqual({
      tabId: loneSurrogate,
      numericPaneId: '12',
      paneKey: `${loneSurrogate}:12`
    })
  })

  // The twin's `UUID_RE.test(value)` coerces; the dispatch adapter answers
  // "expects a string", which would throw out of a predicate.
  it('coerces a non-string id the way the twin’s regex did', () => {
    const notAString = undefined as unknown as string
    expect(isStablePaneId(notAString)).toBe(false)
    expect(isTerminalLeafId(notAString)).toBe(false)
    expect(isStablePaneId(LEAF_ID as unknown as string)).toBe(true)
  })

  // The twin's first line is `typeof paneKey !== 'string'`, so shapes the codec
  // refuses (Date, Map, NaN, bigint) must not reach the encoder at all.
  it('answers every non-string legacy key with null, never a codec throw', () => {
    for (const value of [5, Number.NaN, -0, true, null, undefined, [], {}, new Date(), new Map()]) {
      expect(parseLegacyNumericPaneKey(value)).toBeNull()
    }
    expect(parseLegacyNumericPaneKey(123n)).toBeNull()
  })

  // U+FEFF is in the JS trim set and not in Rust's; U+0085 is the reverse. The
  // core carries `trim_js` so both legs agree, and a byte cap would reject the
  // accented key the twin accepts.
  it('trims with the JS whitespace set and caps in UTF-16 code units', () => {
    const bound = {
      feff: parseLegacyNumericPaneKey('\uFEFFtab-1:12\uFEFF'),
      nel: parseLegacyNumericPaneKey('tab-1:12\u0085'),
      leadingNel: parseLegacyNumericPaneKey('\u0085tab-1:12'),
      accented: parseLegacyNumericPaneKey(`${'é'.repeat(200)}:12`),
      over: parseLegacyNumericPaneKey(`${'a'.repeat(254)}:12`)
    }
    expect(bound.feff).toEqual({ tabId: 'tab-1', numericPaneId: '12', paneKey: 'tab-1:12' })
    expect(bound.nel).toBeNull()
    expect(bound.leadingNel?.tabId).toBe('\u0085tab-1')
    expect(bound.accented?.numericPaneId).toBe('12')
    expect(bound.over).toBeNull()
    expect(
      withUnboundSeam(() => ({
        feff: parseLegacyNumericPaneKey('\uFEFFtab-1:12\uFEFF'),
        nel: parseLegacyNumericPaneKey('tab-1:12\u0085'),
        leadingNel: parseLegacyNumericPaneKey('\u0085tab-1:12'),
        accented: parseLegacyNumericPaneKey(`${'é'.repeat(200)}:12`),
        over: parseLegacyNumericPaneKey(`${'a'.repeat(254)}:12`)
      }))
    ).toEqual(bound)
  })

  it('answers identically with the seam unbound, across the whole surface', () => {
    const probe = (): unknown => [
      isStablePaneId(LEAF_ID),
      isStablePaneId('11111111-1111-4111-8111-11111111111A'),
      isTerminalLeafId('nope'),
      makePaneKey('tab-1', LEAF_ID),
      parsePaneKey(`tab-1:${LEAF_ID}`),
      parsePaneKey('tab-1:1'),
      parseLegacyNumericPaneKey(' tab-1:12 '),
      parseLegacyNumericPaneKey('tab-1:x')
    ]
    // Read the bound answer FIRST: withUnboundSeam does not restore the binding,
    // so evaluating the expected side after it would compare unbound to unbound.
    const ready = probe()
    expect(withUnboundSeam(probe)).toEqual(ready)
  })

  // A core that is reached but cannot answer must stay loud: folding it into the
  // fallback would make a dead core indistinguishable from a healthy one.
  it('propagates a core failure instead of quietly answering from the fallback', () => {
    setOrcaDispatchBinding(() => JSON.stringify({ __parity_error__: 'unknown function' }))
    expect(() => parsePaneKey(`tab-1:${LEAF_ID}`)).toThrow(/failed in the Rust core/)
    expect(() => isStablePaneId(LEAF_ID)).toThrow(/failed in the Rust core/)
  })
})
