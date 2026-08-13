/**
 * The ONE encoder/decoder for the TypeScript ↔ Rust dispatch boundary.
 *
 * Every Rust call in the app crosses the same seam:
 *
 *     JSON.parse(binding.orcaDispatch(module, fn, JSON.stringify(input)))
 *
 * Both halves of that line lie. `JSON.stringify` emits a lone UTF-16 surrogate as
 * `"\ud800"` — valid JSON text, NOT decodable UTF-8 — so serde fails to parse the
 * whole payload; it writes `null` for NaN/Infinity; and it DROPS keys whose value
 * is `undefined`. On the Rust side a parse failure used to become `Value::Null`,
 * i.e. an argument-less call, so the module answered confidently against nothing.
 * That was measured on `task-claim`, the fleet's only signal that can contradict
 * an agent's self-report: an agent-authored path list carrying one lone surrogate
 * turned "mismatch — three files claimed, git shows none" into "unknown", in the
 * direction that exonerates the audited thing, with nothing logged.
 *
 * The rule here is: a payload that cannot survive the crossing is IMPOSSIBLE TO
 * ENCODE, and every rejection names the field and why, because the person reading
 * the stack trace is the shim author who has to fix it.
 *
 * The Rust twin of this contract is `rust/crates/orca-dispatch/src/json_entry.rs`
 * (shared by the napi and wasm bindings, so the two ends cannot drift).
 *
 * WHAT CROSSES, exactly:
 *
 * | JS value                        | encode                                    |
 * | ------------------------------- | ----------------------------------------- |
 * | string (incl. matched pairs 🚀) | verbatim; astral chars round-trip         |
 * | string with a LONE surrogate    | REJECTED (path + code-unit index)         |
 * | finite number, `0`              | verbatim                                  |
 * | `-0`                            | REJECTED (JSON has no signed zero)        |
 * | NaN / ±Infinity                 | REJECTED (JSON.stringify writes null)     |
 * | boolean, null                   | verbatim                                  |
 * | top-level `undefined`           | `"null"` — the documented no-arg call     |
 * | `undefined` as a property value | REJECTED, or omitted on explicit opt-in   |
 * | `undefined` in an array         | REJECTED (JSON.stringify writes null)     |
 * | array hole (sparse)             | REJECTED (JSON.stringify writes null)     |
 * | extra own props on an array     | REJECTED (JSON.stringify drops them)      |
 * | plain object / array            | verbatim                                  |
 * | Date, Map, Set, class instance  | REJECTED (stringify substitutes or empties)|
 * | any object with `toJSON`        | REJECTED (it would rewrite itself)        |
 * | symbol key or symbol value      | REJECTED (silently dropped)               |
 * | bigint, function                | REJECTED                                  |
 * | cyclic / >128 deep              | REJECTED at the depth cap, path shown     |
 *
 * Nothing on that table is normalized behind your back: it round-trips or it
 * throws. Decoding recognises both Rust failure envelopes (`__dispatch_error__`
 * from the entry, `__parity_error__` from a module) and throws, so an error can
 * never be returned as a result.
 *
 * `encodeNumericDispatchPayload` is the documented fast path for all-numeric
 * payloads on hot call sites; `config/scripts/dispatch-payload-codec-benchmark.mjs`
 * is the standing measurement of what the safe path costs.
 */

import {
  DispatchPayloadError,
  childPath,
  describeArrayDefect,
  describeExotic,
  describeType,
  reject,
  rejectNumber
} from './dispatch-payload-rejection'
import type { PathTrail } from './dispatch-payload-rejection'

// One public import site for shim authors: the rejection type ships from the codec.
export { DispatchPayloadError } from './dispatch-payload-rejection'

/** Reserved key: the dispatch entry's failure envelope (unknown module, unparseable input). */
export const DISPATCH_ERROR_KEY = '__dispatch_error__'

/** Reserved key: a module's own failure envelope, which every ported module uses
 *  for an unknown function name. Nothing in TS recognised it before this codec. */
export const MODULE_ERROR_KEY = '__parity_error__'

/** Cyclic references and pathological nesting both die here; JSON payloads are shallow. */
const MAX_DEPTH = 128

// Why: ES2019 well-formed JSON.stringify emits a LONE surrogate as the six ASCII
// characters `\ud800` (matched pairs stay raw), so the hazard is detectable with
// one regex over the output text instead of a scan of every string on the hot path.
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/

/** The Rust core answered with a failure (or with something undecodable). */
export class DispatchCoreError extends Error {
  readonly kind: 'core-error' | 'malformed-response'

  constructor(kind: 'core-error' | 'malformed-response', detail: string, call?: DispatchCallSite) {
    const where = call ? `${call.module}.${call.fn}` : 'orcaDispatch'
    super(
      kind === 'core-error'
        ? `${where} failed in the Rust core: ${detail}`
        : `${where} returned a response the boundary cannot decode: ${detail}`
    )
    this.name = 'DispatchCoreError'
    this.kind = kind
  }
}

/** Names the call in error messages; pass it so a stack trace says which shim. */
export type DispatchCallSite = { module: string; fn: string }

export type DispatchEncodeOptions = {
  /**
   * What an own property whose value is `undefined` means.
   * - `'reject'` (default): `{a: undefined}` and `{}` must not arrive identical.
   * - `'omit'`: the caller asserts, for this module, that absent ≡ undefined
   *   (matching serde's `Option<T>` treatment of a missing field).
   */
  undefinedProperties?: 'reject' | 'omit'
  /** Root name in rejection paths; use the shim's argument name. Default `input`. */
  root?: string
}

/**
 * Encode a dispatch payload, or throw naming the field that cannot cross.
 *
 * Top-level `undefined` and `null` both encode as `"null"` — the no-arg call the
 * Rust entry documents. They are the one deliberate conflation, and Rust cannot
 * tell them apart either.
 */
export function encodeDispatchPayload(value: unknown, options: DispatchEncodeOptions = {}): string {
  const root = options.root ?? 'input'
  if (value === undefined) {
    return 'null'
  }
  // Why a trail array instead of a path string threaded down: building
  // `input.rows[3].nested.a` for every field the walk PASSES cost more than every
  // other check combined (measured 2.9x → 1.7x bare on a 200-row payload). Push
  // the key, render the path only when rejecting.
  assertEncodable(value, [root], options.undefinedProperties === 'omit')
  const text = JSON.stringify(value) as string
  if (LONE_SURROGATE_ESCAPE.test(text)) {
    // The regex also matches a literal backslash-u-d… in the DATA, so confirm
    // against the values before rejecting; a matched pair (🚀) never gets here.
    const found = findLoneSurrogate(value, root)
    if (found) {
      throw new DispatchPayloadError(
        found.path,
        `contains an unpaired UTF-16 surrogate (0x${found.codeUnit.toString(16)}) at code-unit ${found.index}, which JSON.stringify emits as a \\u escape that is not valid UTF-8, so the Rust side cannot parse the payload at all. Repair or drop the text before dispatching (a matched surrogate pair, i.e. a real astral character, is fine)`
      )
    }
  }
  return text
}

/**
 * Fast path for payloads that provably cannot carry any of the hazards: a finite
 * number, or a flat record of them (e.g. `keep-tail`'s `{droppableSessions: n}`,
 * whose `update` runs on every pending-data change). No recursion and no
 * per-string scan — just a typeof/finite check per value, plus the same one-regex
 * surrogate check on the output so a dynamically-built key cannot slip through.
 */
export function encodeNumericDispatchPayload(
  payload: number | Readonly<Record<string, number>>,
  options: Pick<DispatchEncodeOptions, 'root'> = {}
): string {
  const root = options.root ?? 'input'
  if (typeof payload === 'number') {
    if (!isEncodableNumber(payload)) {
      rejectNumber(payload, [root])
    }
    return JSON.stringify(payload)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    reject([root], 'is not a number or a flat record of numbers — use encodeDispatchPayload')
  }
  // Why the prototype check and not just the key walk: Object.keys(new Date()) is [], so every
  // exotic object with no own enumerable keys — Date, Map, Set, RegExp, a class instance — walked
  // zero entries, hit no rejection, and was stringified as whatever it happened to stringify to.
  // The fast path has to refuse the same shapes the full encoder refuses, or it is a hole with a
  // performance justification.
  const proto: unknown = Object.getPrototypeOf(payload)
  if (proto !== null && proto !== Object.prototype) {
    reject(
      [root],
      `is ${describeType(payload)}, not a plain record — the all-numeric fast path only accepts plain objects; use encodeDispatchPayload`
    )
  }
  for (const key of Object.keys(payload)) {
    const entry: unknown = payload[key]
    if (typeof entry !== 'number') {
      reject(
        [root, key],
        `is ${describeType(entry)}, but this is the all-numeric fast path — use encodeDispatchPayload`
      )
    }
    if (!isEncodableNumber(entry)) {
      rejectNumber(entry, [root, key])
    }
  }
  const text = JSON.stringify(payload)
  if (LONE_SURROGATE_ESCAPE.test(text)) {
    reject([root], 'has a key containing an unpaired UTF-16 surrogate')
  }
  return text
}

/**
 * Decode what the Rust core returned. Throws `DispatchCoreError` for either
 * failure envelope — `__dispatch_error__` from the entry (unknown module, or a
 * payload it could not parse) and `__parity_error__` from a module (unknown
 * function) — so a shim can never hand an error object back to a caller expecting
 * a result. A module result must not use either key.
 */
export function decodeDispatchResult(text: string, call?: DispatchCallSite): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new DispatchCoreError(
      'malformed-response',
      `${(cause as Error).message} (${text.length} chars)`,
      call
    )
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const envelope = parsed as Record<string, unknown>
    if (DISPATCH_ERROR_KEY in envelope) {
      throw new DispatchCoreError('core-error', String(envelope[DISPATCH_ERROR_KEY]), call)
    }
    if (MODULE_ERROR_KEY in envelope) {
      throw new DispatchCoreError(
        'core-error',
        `${String(envelope[MODULE_ERROR_KEY])} — the module was reached but the function was not, so this is a typo or an unported function, not a bad payload`,
        call
      )
    }
  }
  return parsed
}

/** -0 is the only finite number JSON cannot express — it would arrive as 0. */
function isEncodableNumber(value: number): boolean {
  return Number.isFinite(value) && (value !== 0 || 1 / value === Number.POSITIVE_INFINITY)
}

function assertEncodable(value: unknown, trail: PathTrail, omitUndefined: boolean): void {
  if (value === null) {
    return
  }
  if (trail.length > MAX_DEPTH) {
    reject(
      trail,
      `is nested deeper than ${MAX_DEPTH} levels — a cyclic reference is the usual cause, and JSON cannot express one`
    )
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!isEncodableNumber(value)) {
        rejectNumber(value, trail)
      }
      return
    case 'undefined':
      reject(
        trail,
        'is undefined, which JSON.stringify writes as null here — pass null explicitly if that is what you mean'
      )
      break
    case 'bigint':
      reject(
        trail,
        `is a bigint (${value}n), which JSON.stringify refuses to serialize — send it as a number if it fits, or as a decimal string`
      )
      break
    case 'symbol':
      reject(trail, 'is a symbol, which JSON.stringify silently drops or nulls')
      break
    case 'function':
      reject(trail, 'is a function, which JSON.stringify silently drops')
      break
    case 'object':
      assertEncodableObject(value as object, trail, omitUndefined)
  }
  // Why no `default:` — the switch covers every `typeof` result, so a default is unreachable and
  // the type-aware lint rejects it. A future typeof would fail exhaustiveness here instead.
}

function assertEncodableObject(value: object, trail: PathTrail, omitUndefined: boolean): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject(
      trail,
      'has symbol-keyed own properties, which JSON.stringify silently drops — move them to string keys if the Rust module needs them'
    )
  }
  if (Array.isArray(value)) {
    // Why one Object.keys instead of per-element `in`: it catches array HOLES and
    // extra own properties (`list.total = 5`) in a single pass, both of which
    // JSON.stringify mangles without a word.
    const keys = Object.keys(value)
    if (keys.length !== value.length) {
      reject(trail, describeArrayDefect(value, keys))
    }
    for (let index = 0; index < value.length; index++) {
      trail.push(index)
      assertEncodable(value[index], trail, omitUndefined)
      trail.pop()
    }
    return
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) {
    reject(trail, describeExotic(value))
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    reject(
      trail,
      'defines toJSON, so JSON.stringify would send something other than this object — call it yourself and pass the result'
    )
  }
  for (const key of Object.keys(value)) {
    const child: unknown = (value as Record<string, unknown>)[key]
    trail.push(key)
    if (child === undefined && !omitUndefined) {
      reject(
        trail,
        'is explicitly undefined, and JSON.stringify DROPS the key, so the Rust side cannot tell it from an absent one — delete the key, pass null, or opt in with {undefinedProperties: "omit"} if absent means undefined for this module'
      )
    }
    if (child !== undefined) {
      assertEncodable(child, trail, omitUndefined)
    }
    trail.pop()
  }
}

type LoneSurrogate = { path: string; index: number; codeUnit: number }

/** Error path only: locate the unpaired surrogate so the message can name the field. */
function findLoneSurrogate(value: unknown, path: string): LoneSurrogate | null {
  if (typeof value === 'string') {
    const index = loneSurrogateIndex(value)
    return index < 0 ? null : { path, index, codeUnit: value.charCodeAt(index) }
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findLoneSurrogate(value[index], `${path}[${index}]`)
      if (found) {
        return found
      }
    }
    return null
  }
  for (const key of Object.keys(value)) {
    const keyIndex = loneSurrogateIndex(key)
    if (keyIndex >= 0) {
      return { path: childPath(path, key), index: keyIndex, codeUnit: key.charCodeAt(keyIndex) }
    }
    const found = findLoneSurrogate((value as Record<string, unknown>)[key], childPath(path, key))
    if (found) {
      return found
    }
  }
  return null
}

/** Index of the first unpaired surrogate code unit, or -1. Matched pairs are legal. */
function loneSurrogateIndex(text: string): number {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return index
      }
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return index
    }
  }
  return -1
}
