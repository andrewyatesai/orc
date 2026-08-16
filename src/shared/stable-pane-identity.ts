// Stable pane ids and pane keys on the Rust `orca_core::stable_pane_id` core.
// This sits on `orca-dispatch-seam` rather than in one tree's binding directory
// because a pane key is minted and read on EVERY surface: main + cli (napi),
// the SSH relay and the WSL hook relay (wasm via initSync), the renderer (wasm
// at ready) and `src/shared` itself (`agent-hook-listener.ts`,
// `agent-session-host-authority.ts`), which also runs under the relay.
//
// PRE-READY CONTRACT — `parity` ×5, and it is FORCED, not chosen. Every export
// lands somewhere that cannot hold a signal: `makePaneKey` mints the React key
// at `TerminalPane.tsx` and the `Map`/record key the hook server, the store and
// `persistence.ts` route panes by; `parsePaneKey` and
// `parseLegacyNumericPaneKey` already return the twin's real `null` for "not a
// pane key", and their tab/leaf ids are PERSISTED as pane-key aliases; the two
// predicates are bare booleans read inside `if`. There is no spare state
// anywhere (ported-modules.md, "Signal at the level that has a spare state" —
// lifting to a list does not help, each answer decides ONE pane). So the
// fallback recomputes the deleted bodies over the constants the twin keeps,
// which makes pre-ready equal ready for every input.
//
// PROVED, not asserted: 71,771 fallback-vs-core comparisons — every
// single-position mutation of a valid UUID (substitute over
// `- g 0 f F 9 A : space é 😀 U+0085 U+FEFF`, plus deletion and insertion at
// each of the 36 positions), all 16x8 version/variant pairs, all 25 JS-trim
// code points plus U+0085 leading/trailing/both, 40k random hex-ish ids, every
// 4-atom string over `- 0 a f g 4 8 :`, the 250-257 length boundary in UTF-16
// units AND UTF-8 bytes for 1/2/4-byte characters, and 39k makePaneKey pairs
// including every throwing tab id — 0 divergences, against BOTH shipped
// artifacts (`orca_git_wasm_bg.wasm` and `orca_node.node`). The corpus is
// discriminating: a byte length cap reddens 6 cases, Rust's `char::is_whitespace`
// trim 8, an `i`-flagged UUID regex 793.
//
// `makePaneKey` THROWS on a bad tab or leaf id and that throw is the contract —
// `persistence.ts` registerLegacyAlias, `useIpcEvents` tryMakePaneKey and
// `aterm-pane-open` all catch it as "not a pane". The fallback is therefore
// computed EAGERLY so the thrown value is the twin's own `Error` with the twin's
// message: the core signals the same rejection through the `__parity_error__`
// envelope, which `decodeDispatchResult` cannot tell apart from a stale core's
// "unknown function makePaneKey", and folding that into a validation throw would
// turn a dead core into a session with no panes and nothing logged.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  LEGACY_NUMERIC_PANE_ID_PATTERN,
  LEGACY_NUMERIC_PANE_KEY_MAX_LENGTH,
  STABLE_PANE_ID_PATTERN,
  type PaneKey,
  type StablePaneId,
  type TerminalLeafId
} from './stable-pane-id'

export type { PaneKey, StablePaneId, TerminalLeafId } from './stable-pane-id'

export type ParsedPaneKey = {
  tabId: string
  leafId: TerminalLeafId
  stablePaneId: StablePaneId
}

export type ParsedLegacyNumericPaneKey = {
  tabId: string
  numericPaneId: string
  paneKey: string
}

/** `null` means "the seam is unbound, or the text cannot cross" — never an
 *  answer. A pane key carries a tab id and a leaf id lifted off persisted JSON
 *  and off the relay wire, so it can hold an unpaired UTF-16 surrogate; the
 *  codec refuses that (it is not valid UTF-8, so Rust cannot parse the payload
 *  at all) and the twin answered it without crossing anything, so the caller
 *  falls back. Only the encode rejection is caught; a DispatchCoreError still
 *  propagates. */
function dispatchStablePaneId(fn: string, input: unknown, root: string): unknown | null {
  try {
    return tryOrcaDispatch('stable-pane-id', fn, input, { root })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

export function isStablePaneId(value: string): value is StablePaneId {
  const fallback = STABLE_PANE_ID_PATTERN.test(value)
  // The twin's regex COERCES a non-string (ids also arrive from persisted JSON
  // and off the wire); the core's adapter answers "expects a string", an
  // envelope that would throw where the twin answered false.
  if (typeof value !== 'string') {
    return fallback
  }
  const answer = dispatchStablePaneId('isStablePaneId', value, 'value')
  return answer === null ? fallback : (answer as boolean)
}

export function isTerminalLeafId(value: string): value is TerminalLeafId {
  const fallback = STABLE_PANE_ID_PATTERN.test(value)
  if (typeof value !== 'string') {
    return fallback
  }
  const answer = dispatchStablePaneId('isTerminalLeafId', value, 'value')
  return answer === null ? fallback : (answer as boolean)
}

/** The deleted twin's body, verbatim over the kept pattern. Throws exactly what
 *  it threw, because the throw is what every caller branches on. */
function legacyMakePaneKey(tabId: string, stableLeafId: string): PaneKey {
  if (!tabId || tabId.includes(':')) {
    throw new Error('tabId must be non-empty and must not contain ":"')
  }
  if (!STABLE_PANE_ID_PATTERN.test(stableLeafId)) {
    throw new Error('stableLeafId must be a UUID')
  }
  return `${tabId}:${stableLeafId}` as PaneKey
}

export function makePaneKey(tabId: string, stableLeafId: string): PaneKey {
  // Eager, so a rejection throws the twin's own Error with the twin's message.
  const fallback = legacyMakePaneKey(tabId, stableLeafId)
  // A non-string id reaches the twin's template literal and stringifies; the
  // core's adapter rejects it and the bound seam throws instead.
  if (typeof tabId !== 'string' || typeof stableLeafId !== 'string') {
    return fallback
  }
  const answer = dispatchStablePaneId('makePaneKey', { tabId, stableLeafId }, 'paneKeyParts')
  return answer === null ? fallback : (answer as PaneKey)
}

/** The deleted twin's body, verbatim. */
function legacyParsePaneKey(paneKey: string): ParsedPaneKey | null {
  const first = paneKey.indexOf(':')
  if (first <= 0 || first !== paneKey.lastIndexOf(':') || first === paneKey.length - 1) {
    return null
  }
  const leafId = paneKey.slice(first + 1)
  if (!STABLE_PANE_ID_PATTERN.test(leafId)) {
    return null
  }
  return {
    tabId: paneKey.slice(0, first),
    leafId: leafId as TerminalLeafId,
    stablePaneId: leafId as StablePaneId
  }
}

export function parsePaneKey(paneKey: string): ParsedPaneKey | null {
  const fallback = legacyParsePaneKey(paneKey)
  // Same reason as the predicates above, and it is REACHABLE: the twin's body
  // only calls `.indexOf`, which an Array also has, so `parsePaneKey([])`
  // answered null. The core's adapter answers "expects a string", which
  // `decodeDispatchResult` turns into a throw once the seam is bound — a
  // divergence that only appears BOUND, which is why a fallback-vs-core
  // differential could not see it.
  if (typeof paneKey !== 'string') {
    return fallback
  }
  const answer = dispatchStablePaneId('parsePaneKey', paneKey, 'paneKey')
  // `null` here is "no binding" or the core's real "not a pane key"; collapsing
  // them is safe only because this shim is parity — the core never rejects a key
  // the fallback parsed, so the fallback recomputes that same null.
  return answer === null ? fallback : (answer as ParsedPaneKey)
}

/** The deleted twin's body, verbatim over the kept cap and digit pattern. */
function legacyParseLegacyNumericPaneKey(paneKey: unknown): ParsedLegacyNumericPaneKey | null {
  if (typeof paneKey !== 'string' || paneKey.length > LEGACY_NUMERIC_PANE_KEY_MAX_LENGTH) {
    return null
  }
  const trimmed = paneKey.trim()
  const delimiter = trimmed.indexOf(':')
  if (
    delimiter <= 0 ||
    delimiter !== trimmed.lastIndexOf(':') ||
    delimiter === trimmed.length - 1
  ) {
    return null
  }
  const numericPaneId = trimmed.slice(delimiter + 1)
  if (!LEGACY_NUMERIC_PANE_ID_PATTERN.test(numericPaneId)) {
    return null
  }
  return { tabId: trimmed.slice(0, delimiter), numericPaneId, paneKey: trimmed }
}

export function parseLegacyNumericPaneKey(paneKey: unknown): ParsedLegacyNumericPaneKey | null {
  const fallback = legacyParseLegacyNumericPaneKey(paneKey)
  // The twin takes `unknown` and answers null for every non-string, so nothing
  // else is worth encoding — and a Date/Map/bigint/NaN the codec refuses would
  // otherwise throw out of a function whose whole first line is that check.
  if (typeof paneKey !== 'string') {
    return null
  }
  const answer = dispatchStablePaneId('parseLegacyNumericPaneKey', paneKey, 'paneKey')
  return answer === null ? fallback : (answer as ParsedLegacyNumericPaneKey)
}
